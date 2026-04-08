export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { ingredient, recipe } = req.body || {};
  if (!ingredient) return res.status(400).json({ error: 'ingredient is required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const prompt = `I'm making "${recipe?.title || 'a dish'}" but I don't have this ingredient: "${ingredient}".

Other ingredients in the recipe: ${recipe?.ingredients?.filter(i => i.text !== ingredient).map(i => i.text).join(', ') || 'not specified'}.

Suggest the best substitute. Return ONLY a JSON object — no markdown, no explanation:
{
  "substitute": "2 tbsp soy sauce",
  "tip": "One concise sentence explaining why this works and any adjustment needed."
}

The substitute should be a drop-in replacement with the same quantity format where possible.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 256, messages: [{ role: 'user', content: prompt }] }),
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
    catch { return res.status(500).json({ error: 'Failed to parse substitution from Claude' }); }

    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
