export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    let apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: 'サーバーにGemini APIキーが設定されていません。' });
    }
    apiKey = apiKey.trim().replace(/^["']|["']$/g, '');

    try {
        const { images, image } = req.body;
        
        let imageList = [];
        if (images && Array.isArray(images)) {
            imageList = images;
        } else if (image) {
            imageList = [image];
        }

        if (imageList.length === 0) {
            return res.status(400).json({ error: '画像データがありません。' });
        }

        const parts = [
            { 
                text: "フラット補正されたレシート画像（複数枚の場合は1つの長尺レシートとして統合）から取引データを抽出し、以下のJSON形式のみで出力してください：{\"date\": \"YYYY-MM-DD\", \"store\": \"店舗名\", \"total\": 税込合計金額の数値, \"tax\": 消費税額の数値(不明なら0), \"category\": \"勘定科目(消耗品費、旅費交通費、接待交際費、会議費、通信費などから選択)\"}" 
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

        const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`, {
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