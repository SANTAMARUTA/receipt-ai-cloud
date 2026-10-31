export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    let apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'APIキーが設定されていません' });
    apiKey = apiKey.trim().replace(/^["']|["']$/g, '');

    try {
        const { image, mode } = req.body;
        if (!image) return res.status(400).json({ error: '画像データがありません' });

        let promptText = "";
        if (mode === 'long') {
            promptText = "これは長いレシートを分割撮影した中の1枚です。この画像から取引データを丁寧に抽出し、軽減税率(8%)と通常税率(10%)が混在している場合は税率ごとに分けて複数行（配列）で抽出してください。以下のJSON配列形式のみで出力：[{\"date\": \"YYYY-MM-DD\", \"store\": \"店舗名\", \"total\": 金額数値, \"tax\": 消費税額数値, \"category\": \"勘定科目\", \"regNo\": \"登録番号(Tから始まる番号,不明なら空欄)\", \"note\": \"備考\"}]";
        } else {
            promptText = "これはレシート/領収書画像です。情報を丁寧に抽出し、軽減税率(8%)と通常税率(10%)が混在している場合は分けて複数行で抽出してください。以下のJSON配列形式（または単一オブジェクト）で出力：[{\"date\": \"YYYY-MM-DD\", \"store\": \"店舗名\", \"total\": 金額数値, \"tax\": 消費税額数値, \"category\": \"勘定科目\", \"regNo\": \"登録番号(Tから始まる番号,不明なら空欄)\", \"note\": \"備考\"}]";
        }

        const parts = [{ text: promptText }];
        const matches = image.match(/^data:(image\/[a-zA-Z+-]+);base64,(.+)$/);
        if (matches) {
            parts.push({ inline_data: { mime_type: matches[1], data: matches[2] } });
        }

        // 安定稼働する確実なモデル順序
        const modelsToTry = ["gemini-3.8-flash", "gemini-3.6-flash"];
        let data = null;
        let lastError = null;

        for (const modelName of modelsToTry) {
            try {
                const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: parts }],
                        generationConfig: { 
                            temperature: 0.1, 
                            responseMimeType: "application/json"
                        }
                    })
                });

                const resJson = await geminiRes.json();
                if (geminiRes.ok) {
                    data = resJson;
                    break;
                } else {
                    lastError = resJson.error?.message || `HTTP ${geminiRes.status}`;
                }
            } catch (err) {
                lastError = err.message;
            }
        }

        if (!data) {
            throw new Error(`AIサーバー混雑 (${lastError})`);
        }

        const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!textResponse) throw new Error('AIからの応答がありません');

        const cleanJsonStr = textResponse.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsedData = JSON.parse(cleanJsonStr);

        return res.status(200).json(parsedData);
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message || 'サーバーエラー' });
    }
}