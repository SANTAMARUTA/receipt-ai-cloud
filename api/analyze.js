export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    let apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'APIキーが設定されていません' });
    apiKey = apiKey.trim().replace(/^["']|["']$/g, '');

    try {
        const { images, image, mode } = req.body;
        const imgList = Array.isArray(images) && images.length > 0 ? images : (image ? [image] : []);
        if (imgList.length === 0) return res.status(400).json({ error: '画像データがありません' });

        let promptText = "";
        if (mode === 'long' || imgList.length > 1) {
            promptText = `これらは1つの長いレシートを${imgList.length}枚に分割して撮影した画像セットです。全体を1つの取引として統合して抽出してください。
【スピード最優先ルール】
・読み取れない項目や記載がない項目は長考せず即座に空文字 ""（数値は 0）にしてください。
・文字のかすれ、手書き、見切れ等で「読み取ったが自信がない項目」があれば、その項目キー名（date, store, total, tax, category, regNo, note のいずれか）を uncertain 配列に入れてください。
・軽減税率(8%)と通常税率(10%)が混在している場合は税率ごとに分けて配列で出力してください。
以下のJSON配列形式のみで出力：
[{"date": "YYYY-MM-DD", "store": "店舗名", "total": 税込金額数値, "tax": 消費税数値, "category": "勘定科目", "regNo": "登録番号(T+13桁,不明なら空欄)", "note": "備考(長尺結合・税率等)", "uncertain": ["自信がない項目キー名"]}]`;
        } else {
            promptText = `これはレシート/領収書/伝票の画像です。情報を高速に抽出してください。
【スピード最優先ルール】
・読み取れない項目や記載がない項目は長考せず即座に空文字 ""（数値は 0）にしてください。
・文字のかすれ、手書き、見切れ等で「読み取ったが自信がない項目」があれば、その項目キー名（date, store, total, tax, category, regNo, note のいずれか）を uncertain 配列に入れてください。
・軽減税率(8%)と通常税率(10%)が混在している場合は税率ごとに分けて配列で出力してください。
以下のJSON配列形式のみで出力：
[{"date": "YYYY-MM-DD", "store": "店舗名", "total": 税込金額数値, "tax": 消費税数値, "category": "勘定科目", "regNo": "登録番号(T+13桁,不明なら空欄)", "note": "備考", "uncertain": ["自信がない項目キー名"]}]`;
        }

        const parts = [{ text: promptText }];
        for (const imgBase64 of imgList) {
            const matches = String(imgBase64).match(/^data:(image\/[a-zA-Z+-]+);base64,(.+)$/);
            if (matches) {
                parts.push({ inline_data: { mime_type: matches[1], data: matches[2] } });
            }
        }

        // 高速・低負荷なモデルを優先し、混雑時は即座に別モデルへフォールバック
        const modelsToTry = [
            { name: "gemini-2.5-flash-lite", noThinking: true },
            { name: "gemini-2.5-flash", noThinking: true },
            { name: "gemini-3.8-flash", noThinking: false },
            { name: "gemini-3.6-flash", noThinking: false }
        ];

        let data = null;
        let lastError = null;

        for (const modelInfo of modelsToTry) {
            try {
                const genConfig = {
                    temperature: 0.1,
                    responseMimeType: "application/json"
                };
                if (modelInfo.noThinking) {
                    genConfig.thinkingConfig = { thinkingBudget: 0 };
                }

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 18000);

                const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelInfo.name}:generateContent?key=${apiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: parts }],
                        generationConfig: genConfig
                    }),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                const resJson = await geminiRes.json();
                if (geminiRes.ok && resJson.candidates?.[0]?.content?.parts?.[0]?.text) {
                    data = resJson;
                    break;
                } else {
                    lastError = resJson.error?.message || `HTTP ${geminiRes.status}`;
                }
            } catch (err) {
                lastError = err.name === 'AbortError' ? 'タイムアウト' : err.message;
            }
        }

        // 万が一全モデルが混雑・失敗した場合でも、赤セル（手入力用）として即座に返却して止めない
        if (!data) {
            return res.status(200).json([{
                date: "",
                store: "",
                total: 0,
                tax: 0,
                category: "消耗品費",
                regNo: "",
                note: `AI混雑のため未判定 (${imgList.length}枚)`,
                uncertain: ["date", "store", "total", "tax", "category", "regNo"]
            }]);
        }

        const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const cleanJsonStr = textResponse.replace(/```json/gi, '').replace(/```/g, '').trim();

        let parsedData;
        try {
            parsedData = JSON.parse(cleanJsonStr);
        } catch (e) {
            parsedData = [{
                date: "",
                store: "",
                total: 0,
                tax: 0,
                category: "消耗品費",
                regNo: "",
                note: "一部読み取り不完全（要確認）",
                uncertain: ["date", "store", "total", "tax"]
            }];
        }

        return res.status(200).json(parsedData);
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message || 'サーバーエラー' });
    }
}