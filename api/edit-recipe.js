export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { recipe, instruction } = req.body || {};
  if (!recipe || !instruction?.trim()) {
    return res.status(400).json({ error: 'recipe and instruction are required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const prompt = `You are editing an existing Thermomix TM6 recipe. Here is the current recipe as JSON:

${JSON.stringify(recipe, null, 2)}

The user wants to make this change: "${instruction.trim()}"

Return the complete updated recipe as a JSON object using exactly the same structure. Rules:
- Only modify what the user asked to change; keep everything else identical.
- Preserve the "type" field on each instruction step ("thermomix" or "manual").
- Thermomix steps must keep temperature (°C integer), time (integer seconds), speed (integer 0–10).
- Manual steps must NOT have temperature/time/speed fields.
- Return ONLY the JSON object — no markdown, no explanation, no code fences.`;

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
        messages: [{ role: 'user', content: prompt }],
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

    let updated;
    try {
      updated = JSON.parse(text.trim());
    } catch {
      return res.status(500).json({ error: 'Failed to parse updated recipe from Claude', raw: text });
    }

    if (!updated.title || !updated.ingredients || !updated.instructions) {
      return res.status(500).json({ error: 'Updated recipe is missing required fields' });
    }

    return res.status(200).json(updated);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
