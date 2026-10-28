export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    let apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'APIキーが設定されていません' });
    apiKey = apiKey.trim().replace(/^["']|["']$/g, '');

    try {
        const { images, mode } = req.body;
        if (!images || images.length === 0) return res.status(400).json({ error: '画像がありません' });

        let promptText = "";
        if (mode === 'long') {
            promptText = "これらは1つの長いレシートを分割して撮影した複数画像です。全体を1つの取引として統合し、軽減税率(8%)と通常税率(10%)が混在している場合は税率ごとに分けて複数行（配列）で抽出してください。同一レシートである旨を備考欄に記載してください。以下のJSON配列形式のみで出力：[{\"date\": \"YYYY-MM-DD\", \"store\": \"店舗名\", \"total\": 金額数値, \"tax\": 消費税額数値, \"category\": \"勘定科目\", \"regNo\": \"登録番号(Tから始まる番号,不明なら空欄)\", \"note\": \"備考(同一レシート結合・軽減税率等)\"}]";
        } else {
            promptText = "これはレシート/領収書画像です。情報を抽出し、軽減税率(8%)と通常税率(10%)が混在している場合は分けて複数行で抽出してください。以下のJSON配列形式（または単一オブジェクト）で出力：[{\"date\": \"YYYY-MM-DD\", \"store\": \"店舗名\", \"total\": 金額数値, \"tax\": 消費税額数値, \"category\": \"勘定科目\", \"regNo\": \"登録番号(Tから始まる番号,不明なら空欄)\", \"note\": \"備考\"}]";
        }

        const parts = [{ text: promptText }];
        for (const imgBase64 of images) {
            const matches = imgBase64.match(/^data:(image\/[a-zA-Z+-]+);base64,(.+)$/);
            if (matches) {
                parts.push({ inline_data: { mime_type: matches[1], data: matches[2] } });
            }
        }

        const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: parts }],
                generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
            })
        });

        const data = await geminiRes.json();
        if (!geminiRes.ok) throw new Error(data.error?.message || 'Gemini APIエラー');

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