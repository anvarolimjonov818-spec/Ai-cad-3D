'use strict';

module.exports = function handler(req, res) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({
        ok: true,
        step: false,
        drawing: true,
        hasKey: !!String(process.env.ANTHROPIC_API_KEY || '').trim(),
        version: "2.0.0"
    }));
};
