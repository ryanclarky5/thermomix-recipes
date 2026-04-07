export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { description, images } = req.body || {};
  const hasText = description && description.trim();
  const hasImages = Array.isArray(images) && images.length > 0;

  if (!hasText && !hasImages) {
    return res.status(400).json({ error: 'Provide a description or at least one photo' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const schema = `{
  "title": "Recipe Title",
  "description": "An appetising 2-3 sentence description of the dish.",
  "servings": 4,
  "prepTime": 600,
  "totalTime": 2400,
  "ingredients": [
    { "text": "200 g ingredient name, preparation note" }
  ],
  "instructions": [
    {
      "type": "thermomix",
      "text": "Add onion and chop.",
      "temperature": 0,
      "time": 5,
      "speed": 5
    },
    {
      "type": "manual",
      "text": "Season with salt and pepper to taste."
    }
  ]
}`;

  const rules = `
RULES — read carefully:
- Return ONLY the JSON object. No markdown, no explanation, no code fences.
- prepTime and totalTime are in seconds.
- Ingredients: metric units (g, ml, tsp, tbsp); quantity and unit first.
- Aim for 6–12 ingredients and 5–10 steps.
- Write step text in the imperative, starting with the action verb.

STEP TYPE RULES:
Use "thermomix" for any step performed IN the Thermomix bowl: chopping, blending, cooking, steaming, mixing, emulsifying, sautéing, kneading, etc. Always include:
  - temperature: integer °C (use 0 if no heat; use 120 for Varoma)
  - time: integer seconds
  - speed: integer 0–10 (10 = Turbo)

Use "manual" for anything done by hand without the Thermomix: seasoning to taste, plating, resting meat, preheating oven, refrigerating, folding by hand, transferring food. No temperature/time/speed fields for manual steps.

Make the recipe genuinely accurate for a Thermomix TM6.`;

  let textContent;
  if (hasText && hasImages) {
    textContent = `Analyse the photo(s) and generate a Thermomix TM6 recipe using the visible ingredients. The user has also provided this note: "${description.trim()}"

Return the recipe using this exact JSON structure:\n${schema}\n${rules}`;
  } else if (hasImages) {
    textContent = `Analyse the photo(s) above and generate a Thermomix TM6 recipe based on the visible ingredients.

Return the recipe using this exact JSON structure:\n${schema}\n${rules}`;
  } else {
    textContent = `Generate a Thermomix TM6 recipe for: "${description.trim()}"

Return the recipe using this exact JSON structure:\n${schema}\n${rules}`;
  }

  const content = [];
  if (hasImages) {
    for (const img of images) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mediaType || 'image/jpeg',
          data: img.base64,
        },
      });
    }
  }
  content.push({ type: 'text', text: textContent });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{ role: 'user', content }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: `Claude API error: ${err}` });
    }

    const data = await response.json();
    let text = data.content?.[0]?.text || '';

    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) text = fenceMatch[1];

    let recipe;
    try {
      recipe = JSON.parse(text.trim());
    } catch {
      return res.status(500).json({ error: 'Failed to parse recipe JSON from Claude', raw: text });
    }

    if (!recipe.title || !recipe.ingredients || !recipe.instructions) {
      return res.status(500).json({ error: 'Recipe is missing required fields', raw: recipe });
    }

    return res.status(200).json(recipe);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
