// 検証用パッチ: 本番未反映。Vercel api/analyze.js 用。
// 元コードとの互換: POST /api/analyze, {images, mode} -> JSON配列またはJSONオブジェクト。
// 画像そのものやAPIキーをログに出さず、件数・所要時間・HTTPステータスだけ記録する。
export default async function handler(req, res) {
    const started = Date.now();
    const summary = { event: 'receipt_ocr', count: 0, bytes: 0 };
    let lastProviderStatus = null;
    const fail = (status, code, message) => {
        console.warn('[OCR_API]', JSON.stringify({ ...summary, status, code, providerStatus: lastProviderStatus, ms: Date.now() - started }));
        return res.status(status).json({ error: message, code });
    };

    if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'POSTで送信してください');
    let apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return fail(500, 'MISSING_GEMINI_API_KEY', 'AI設定を確認してください');
    apiKey = apiKey.trim().replace(/^["']|["']$/g, '');

    let body;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (_) {
        return fail(400, 'BAD_REQUEST_JSON', '送信内容がJSON形式ではありません');
    }
    const images = body?.images;
    const mode = body?.mode === 'long' ? 'long' : 'normal';
    if (!Array.isArray(images) || images.length === 0) return fail(400, 'NO_IMAGES', '画像がありません');
    summary.count = images.length;
    if (images.length > 50) return fail(400, 'TOO_MANY_IMAGES', '一度に送る画像が多すぎます');

    const parts = [];
    // original prompt is kept to preserve the current OCR fields and tax-splitting semantics.
    const promptText = mode === 'long'
        ? 'これらは1つの長いレシートを分割して撮影した複数画像です。全体を1つの取引として統合し、軽減税率(8%)と通常税率(10%)が混在している場合は税率ごとに分けて複数行（配列）で抽出してください。同一レシートである旨を備考欄に記載してください。以下のJSON配列形式のみで出力：[{"date": "YYYY-MM-DD", "store": "店舗名", "total": 金額数値, "tax": 消費税額数値, "category": "勘定科目", "regNo": "登録番号(Tから始まる番号,不明なら空欄)", "note": "備考(同一レシート結合・軽減税率等)"}]'
        : 'これはレシート/領収書画像です。情報を抽出し、軽減税率(8%)と通常税率(10%)が混在している場合は分けて複数行で抽出してください。以下のJSON配列形式（または単一オブジェクト）で出力：[{"date": "YYYY-MM-DD", "store": "店舗名", "total": 金額数値, "tax": 消費税額数値, "category": "勘定科目", "regNo": "登録番号(Tから始まる番号,不明なら空欄)", "note": "備考"}]';
    parts.push({ text: promptText });

    for (const imgBase64 of images) {
        if (typeof imgBase64 !== 'string') return fail(400, 'BAD_IMAGE', '画像データの形式が不正です');
        const match = imgBase64.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
        if (!match) return fail(400, 'BAD_IMAGE', '画像データの形式が不正です');
        summary.bytes += Buffer.byteLength(imgBase64, 'utf8');
        parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
    }
    // The platform can reject >4.5 MB before this function starts.
    if (summary.bytes > 3.8 * 1024 * 1024) return fail(413, 'IMAGE_BATCH_TOO_LARGE', '画像サイズが大きいため、枚数を減らしてください');

    const generationConfig = { responseMimeType: 'application/json' };
    const level = process.env.GEMINI_OCR_THINKING_LEVEL;
    // Default: unchanged Gemini behavior. Set 'low' only after testing accuracy.
    if (level === 'low' || level === 'medium' || level === 'high') {
        generationConfig.thinkingConfig = { thinkingLevel: level };
    }

    let upstream;
    try {
        upstream = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify({ contents: [{ parts }], generationConfig })
        });
    } catch (e) {
        return fail(502, 'GEMINI_NETWORK_ERROR', 'AIへの接続に失敗しました。時間をおいて再試行してください');
    }
    lastProviderStatus = upstream.status;
    let upstreamJson;
    try {
        upstreamJson = await upstream.json();
    } catch (_) {
        return fail(502, 'GEMINI_NON_JSON_RESPONSE', 'AIサーバーから形式が不正な応答を受信しました');
    }
    if (!upstream.ok) {
        if (upstream.status === 429) return fail(503, 'GEMINI_RATE_LIMIT', 'AI側の利用制限に達しました。時間をおいて再試行してください');
        if (upstream.status >= 500) return fail(502, 'GEMINI_UPSTREAM_5XX', 'AIサーバーが一時的に応答できませんでした');
        return fail(502, 'GEMINI_UPSTREAM_REJECTED', 'AI側が画像解析の要求を受け付けませんでした');
    }
    const textResponse = upstreamJson?.candidates?.[0]?.content?.parts?.find(p => typeof p.text === 'string')?.text;
    if (!textResponse) return fail(502, 'GEMINI_EMPTY', 'AIから解析結果が返りませんでした');
    let parsed;
    try {
        parsed = JSON.parse(textResponse.replace(/```json/g, '').replace(/```/g, '').trim());
    } catch (_) {
        return fail(502, 'GEMINI_INVALID_JSON', 'AIの解析結果が正しいJSON形式ではありません');
    }
    if (!parsed || (typeof parsed !== 'object') ||
        (Array.isArray(parsed) && parsed.some(row => !row || typeof row !== 'object' || Array.isArray(row)))) {
        return fail(502, 'GEMINI_BAD_RESULT_SHAPE', 'AIの解析結果の形式が想定と異なります');
    }
    console.info('[OCR_API]', JSON.stringify({ ...summary, status: 200, providerStatus: lastProviderStatus, ms: Date.now() - started }));
    return res.status(200).json(parsed);
}
