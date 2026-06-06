// Legacy MySQL config — used only by the local sync-sheets.js script (the production
// app runs on MongoDB). Credentials come from the environment; never hardcode them.
// Set DB_HOST / DB_USER / DB_PASSWORD / DB_NAME in your local .env before running it.
require('dotenv').config();

module.exports = {
    db: {
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'paletizado_db',
        waitForConnections: true,
        connectionLimit: 10
    },
    port: process.env.PORT || 3009
};
