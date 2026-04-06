export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { pin } = req.body || {};
  const appPin = process.env.APP_PIN;

  if (!appPin) {
    // No PIN configured — allow through
    return res.status(200).json({ success: true });
  }

  if (String(pin) === String(appPin)) {
    return res.status(200).json({ success: true });
  }

  return res.status(401).json({ success: false, error: 'Incorrect PIN' });
}
