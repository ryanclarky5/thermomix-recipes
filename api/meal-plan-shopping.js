export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { recipes } = req.body || {};
  if (!Array.isArray(recipes) || recipes.length === 0)
    return res.status(400).json({ error: 'recipes array is required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const recipeList = recipes.map(r =>
    `### ${r.title} (serves ${r.servings})\n${r.ingredients.map(i => `- ${i.text}`).join('\n')}`
  ).join('\n\n');

  const prompt = `I'm meal planning for the week with these ${recipes.length} recipes:\n\n${recipeList}\n\nCreate a consolidated weekly shopping list. Merge duplicate ingredients across recipes (e.g. if two recipes need onions, combine them into one entry). Organise by supermarket section.\n\nReturn ONLY a JSON object — no markdown, no explanation:\n{\n  "categories": [\n    { "name": "Produce", "items": ["3 large onions", "4 cloves garlic", "2 lemons"] },\n    { "name": "Meat & Fish", "items": ["600g chicken breast"] },\n    { "name": "Dairy", "items": ["200ml cream", "100g parmesan"] },\n    { "name": "Pantry & Dry Goods", "items": ["400g pasta", "2 tins chopped tomatoes"] },\n    { "name": "Spices & Sauces", "items": ["1 tsp smoked paprika"] }\n  ],\n  "note": "One optional tip about prepping ahead or batch cooking."\n}\n\nOnly include categories that have items. Keep items concise.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
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
    catch { return res.status(500).json({ error: 'Failed to parse shopping list from Claude' }); }

    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
