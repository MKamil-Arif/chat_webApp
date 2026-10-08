// Vercel serverless entry: every /api/* request is rewritten here (see
// vercel.json) and handled by the Express app. Pages and assets in public/
// are served by Vercel's CDN.
module.exports = require('../server');
