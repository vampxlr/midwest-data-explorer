/**
 * Vercel serverless function entry point.
 * Imports and re-exports the Express app from server/index.js.
 * Locally the server runs standalone; on Vercel it runs as a function.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
module.exports = require('../server/index.js');
