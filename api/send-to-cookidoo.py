"""
Vercel Python serverless function.
Uses cookidoo-api to authenticate with email/password, then calls the
Cookidoo web API with the resulting Bearer token to create the recipe.
"""
from http.server import BaseHTTPRequestHandler
import json
import os
import asyncio
import aiohttp

from cookidoo_api import Cookidoo, CookidooConfig, CookidooLocalizationConfig


def _parse_locale(locale: str) -> tuple[str, str]:
    """
    Convert a locale string like 'ch-de' to (country_code, language).
    'ch-de' -> ('ch', 'de-CH')
    'de-DE' -> ('de', 'de-DE')
    """
    parts = locale.lower().split("-")
    country = parts[0]          # 'ch'
    lang = parts[1] if len(parts) > 1 else parts[0]  # 'de'
    language = f"{lang}-{country.upper()}"            # 'de-CH'
    return country, language


async def _push_recipe(recipe: dict) -> dict:
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

    # ── Step 1: Authenticate via cookidoo-api ──────────────────────────────
    async with aiohttp.ClientSession() as auth_session:
        api = Cookidoo(auth_session, cfg)
        await api.login()
        access_token: str = api.auth_data.access_token
        token_type: str = api.auth_data.token_type.lower().capitalize()  # "Bearer"

    # ── Step 2: Push recipe to Cookidoo web API ────────────────────────────
    endpoint = f"{base_url}/created-recipes/{locale}"
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": f"{token_type} {access_token}",
        "User-Agent": "Mozilla/5.0",
    }

    async with aiohttp.ClientSession() as session:
        # POST — create skeleton with just the name, returns a recipe ID
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

        # Brief pause — Cookidoo needs a moment before accepting the PATCH
        await asyncio.sleep(1.5)

        # PATCH — add all recipe details
        async with session.patch(
            f"{endpoint}/{recipe_id}",
            headers=headers,
            json={
                "description": recipe.get("description", ""),
                "yield": {
                    "value": int(recipe.get("servings", 4)),
                    "unitText": "portion",
                },
                "prepTime": int(recipe.get("prepTime", 0)),
                "totalTime": int(recipe.get("totalTime", 0)),
                "tools": ["TM6"],
                "ingredients": recipe.get("ingredients", []),
                "instructions": recipe.get("instructions", []),
            },
        ) as resp:
            if resp.status not in (200, 201, 204):
                raw = await resp.text()
                raise RuntimeError(f"Update failed ({resp.status}): {raw}")

    return {
        "success": True,
        "recipeId": recipe_id,
        "url": f"{base_url}/created-recipes/{locale}/{recipe_id}",
    }


class handler(BaseHTTPRequestHandler):

    def do_POST(self):
        # Parse body
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

        try:
            result = asyncio.run(_push_recipe(recipe))
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
        pass  # suppress default CLF logging in Vercel logs
