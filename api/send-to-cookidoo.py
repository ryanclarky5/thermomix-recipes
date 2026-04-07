"""
Vercel Python serverless function.
Creates new recipes (POST + PATCH) or updates existing ones (PATCH only when recipeId supplied).
"""
from http.server import BaseHTTPRequestHandler
import json
import os
import asyncio
import aiohttp

from cookidoo_api import Cookidoo, CookidooConfig, CookidooLocalizationConfig


def _parse_locale(locale: str) -> tuple[str, str]:
    parts = locale.lower().split("-")
    country = parts[0]
    lang = parts[1] if len(parts) > 1 else parts[0]
    language = f"{lang}-{country.upper()}"
    return country, language


def _format_step_text(step: dict) -> str:
    """Append Thermomix parameters inline for thermomix steps."""
    text = step.get("text", "")
    if step.get("type") == "thermomix":
        parts = []
        temp = step.get("temperature")
        time_s = step.get("time")
        speed = step.get("speed")
        if temp and int(temp) > 0:
            if int(temp) >= 110:
                parts.append("Varoma")
            else:
                parts.append(f"{int(temp)}\u00b0C")
        if time_s:
            time_s = int(time_s)
            m, s = divmod(time_s, 60)
            if m > 0 and s > 0:
                parts.append(f"{m} min {s} sec")
            elif m > 0:
                parts.append(f"{m} min")
            else:
                parts.append(f"{s} sec")
        if speed is not None:
            spd = int(speed)
            parts.append(f"Speed {spd}" if spd < 10 else "Turbo")
        if parts:
            return f"{text} | {' / '.join(parts)}"
    return text


async def _push_recipe(recipe: dict, existing_recipe_id: str | None = None) -> dict:
    email = os.environ["COOKIDOO_EMAIL"]
    password = os.environ["COOKIDOO_PASSWORD"]
    locale = os.environ.get("COOKIDOO_LOCALE", "ch-de")
    base_url = os.environ.get("COOKIDOO_BASE_URL", "https://cookidoo.ch").rstrip("/")

    country_code, language = _parse_locale(locale)

    cfg = CookidooConfig(
        email=email,
        password=password,
        localization=CookidooLocalizationConfig(
            country_code=country_code,
            language=language,
            url=f"{base_url}/foundation/{language}",
        ),
    )

    async with aiohttp.ClientSession() as auth_session:
        api = Cookidoo(auth_session, cfg)
        await api.login()
        access_token: str = api.auth_data.access_token
        token_type: str = api.auth_data.token_type.lower().capitalize()

    endpoint = f"{base_url}/created-recipes/{language}"
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": f"{token_type} {access_token}",
        "User-Agent": "Mozilla/5.0",
    }

    patch_body = {
        "description": recipe.get("description", ""),
        "yield": {
            "value": int(recipe.get("servings", 4)),
            "unitText": "portion",
        },
        "prepTime": int(recipe.get("prepTime", 0)),
        "totalTime": int(recipe.get("totalTime", 0)),
        "tools": ["TM6"],
        "ingredients": [
            {"type": "INGREDIENT", "text": i.get("text", i) if isinstance(i, dict) else i}
            for i in recipe.get("ingredients", [])
        ],
        "instructions": [
            {
                "type": "STEP",
                "text": _format_step_text(s) if isinstance(s, dict) else s,
            }
            for s in recipe.get("instructions", [])
        ],
    }

    async with aiohttp.ClientSession() as session:
        if existing_recipe_id:
            recipe_id = existing_recipe_id
            patch_body["recipeName"] = recipe.get("title", "")
        else:
            async with session.post(
                endpoint,
                headers=headers,
                json={"recipeName": recipe["title"]},
            ) as resp:
                raw = await resp.text()
                if resp.status not in (200, 201):
                    raise RuntimeError(f"Create failed ({resp.status}): {raw}")
                create_data = json.loads(raw)

            recipe_id = (
                create_data.get("recipeId")
                or create_data.get("id")
                or create_data.get("recipe_id")
            )
            if not recipe_id:
                raise RuntimeError(f"No recipe ID in Cookidoo response: {create_data}")

            await asyncio.sleep(1.5)

        async with session.patch(
            f"{endpoint}/{recipe_id}",
            headers=headers,
            json=patch_body,
        ) as resp:
            if resp.status not in (200, 201, 204):
                raw = await resp.text()
                raise RuntimeError(f"Update failed ({resp.status}): {raw}")

    return {
        "success": True,
        "recipeId": recipe_id,
        "url": f"{base_url}/created-recipes/{language}/{recipe_id}",
    }


class handler(BaseHTTPRequestHandler):

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
        except Exception:
            return self._respond(400, {"error": "Invalid JSON body"})

        recipe = body.get("recipe")
        if not recipe or not recipe.get("title"):
            return self._respond(400, {"error": "recipe with title is required"})

        if not os.environ.get("COOKIDOO_EMAIL") or not os.environ.get("COOKIDOO_PASSWORD"):
            return self._respond(
                500, {"error": "COOKIDOO_EMAIL and COOKIDOO_PASSWORD must be set"}
            )

        existing_recipe_id = body.get("recipeId") or None

        try:
            result = asyncio.run(_push_recipe(recipe, existing_recipe_id))
            self._respond(200, result)
        except Exception as exc:
            self._respond(500, {"error": str(exc)})

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def _respond(self, status: int, data: dict):
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass
