export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { description } = req.body || {};
  if (!description || !description.trim()) {
    return res.status(400).json({ error: 'Description is required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const prompt = `Generate a Thermomix recipe for: "${description.trim()}"

Return ONLY a valid JSON object — no markdown, no explanation, no code fences. Use this exact structure:
{
  "title": "Recipe Title",
  "description": "An appetising 2-3 sentence description of the dish.",
  "servings": 4,
  "prepTime": 600,
  "totalTime": 2400,
  "ingredients": [
    { "text": "200 g ingredient name, preparation note" }
  ],
  "instructions": [
    { "text": "Step description with Thermomix parameters where relevant." }
  ]
}

Rules:
- prepTime and totalTime are in seconds
- Ingredients use metric units (g, ml, tsp, tbsp); list quantity and unit first
- Each instruction step must reference specific Thermomix parameters where relevant: temperature in °C, speed 1–10, time in min/sec, and attachment if needed (e.g. butterfly whisk, steaming basket, simmering basket)
- Write instructions in the imperative, starting with the action (e.g. "Add onion and chop 5 sec/speed 5.")
- Aim for 6–12 ingredients and 5–10 steps
- Make the recipe genuinely useful and accurate for a Thermomix TM6`;

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
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: `Claude API error: ${err}` });
    }

    const data = await response.json();
    let text = data.content?.[0]?.text || '';

    // Strip any accidental markdown code fences
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) text = fenceMatch[1];

    let recipe;
    try {
      recipe = JSON.parse(text.trim());
    } catch {
      return res.status(500).json({ error: 'Failed to parse recipe JSON from Claude', raw: text });
    }

    // Basic validation
    if (!recipe.title || !recipe.ingredients || !recipe.instructions) {
      return res.status(500).json({ error: 'Recipe is missing required fields', raw: recipe });
    }

    return res.status(200).json(recipe);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
