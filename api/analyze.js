export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: 'サーバーにGemini APIキーが設定されていません。' });
    }

    try {
        const { images, image } = req.body;
        
        // 単一画像と複数画像（配列）の両方に対応
        let imageList = [];
        if (images && Array.isArray(images)) {
            imageList = images;
        } else if (image) {
            imageList = [image];
        }

        if (imageList.length === 0) {
            return res.status(400).json({ error: '画像データがありません。' });
        }

        // Gemini APIに渡すpartsを作成
        const parts = [
            { 
                text: "これらは1枚の長いレシートを分割して撮影した画像、または複数のレシート画像です。これら全体を統合して1つの取引として扱い、以下のJSON形式のみ（余計な文字やマークダウン不要）でデータを抽出してください：{\"date\": \"YYYY-MM-DD\", \"store\": \"店舗名\", \"total\": 合計金額の数値, \"tax\": 消費税額の数値(不明なら0), \"category\": \"勘定科目(消耗品費、旅費交通費、接待交際費、会議費などから適切に選択)\"}" 
            }
        ];

        for (const imgBase64 of imageList) {
            const matches = imgBase64.match(/^data:(image\/[a-zA-Z+-]+);base64,(.+)$/);
            if (matches) {
                parts.push({
                    inline_data: {
                        mime_type: matches[1],
                        data: matches[2]
                    }
                });
            }
        }

        // Gemini API (gemini-2.5-flash) を呼び出し
        const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: parts }]
            })
        });

        const data = await geminiRes.json();
        if (!geminiRes.ok) {
            throw new Error(data.error?.message || 'Gemini APIの呼び出しに失敗しました。');
        }

        const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!textResponse) {
            throw new Error('AIからの応答を正しく取得できませんでした。');
        }

        const cleanJsonStr = textResponse.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsedData = JSON.parse(cleanJsonStr);

        return res.status(200).json(parsedData);
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message || 'サーバー内部エラーが発生しました。' });
    }
}