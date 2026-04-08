export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { recipe } = req.body || {};
  if (!recipe?.title) return res.status(400).json({ error: 'recipe is required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const prompt = `Estimate the nutritional content per serving for this recipe.

Title: ${recipe.title}
Servings: ${recipe.servings}
Ingredients:
${recipe.ingredients.map(i => `- ${i.text}`).join('\n')}

Return ONLY a JSON object — no markdown, no explanation:
{
  "perServing": {
    "calories": 450,
    "protein": 28,
    "carbs": 45,
    "fat": 18,
    "fibre": 6
  },
  "disclaimer": "One short sentence noting these are rough estimates only."
}

All values are integers. Calories in kcal, everything else in grams.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 512, messages: [{ role: 'user', content: prompt }] }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: `Claude API error: ${err}` });
    }

    const data = await response.json();
    let text = data.content?.[0]?.text || '';
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) text = fenceMatch[1];

    let result;
    try { result = JSON.parse(text.trim()); }
    catch { return res.status(500).json({ error: 'Failed to parse nutrition estimate from Claude' }); }

    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
