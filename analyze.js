// レシートAIクラウド /api/analyze.js 専用修正版（2026-10-28）
// 画面・カメラ・PeerJS側は変更しない。{images,mode} -> 配列または単一オブジェクトを維持。
// Googleへの呼び出しは成功時1回、高負荷/一時障害時のみ予備モデルを1回まで（最大2回）。

const PRIMARY_MODEL = 'gemini-3.6-flash';
const BACKUP_MODEL = 'gemini-3.5-flash-lite';
const MAX_BYTES = Math.floor(3.8 * 1024 * 1024);
const MAX_IMAGES = 40;

const PROMPTS = {
  normal: 'これはレシート/領収書画像です。情報を抽出し、軽減税率(8%)と通常税率(10%)が混在している場合は分けて複数行で抽出してください。以下のJSON配列形式（または単一オブジェクト）で出力：[{"date": "YYYY-MM-DD", "store": "店舗名", "total": 金額数値, "tax": 消費税額数値, "category": "勘定科目", "regNo": "登録番号(Tから始まる番号,不明なら空欄)", "note": "備考"}]',
  long: 'これらは1つの長いレシートを分割して撮影した複数画像です。全体を1つの取引として統合し、軽減税率(8%)と通常税率(10%)が混在している場合は税率ごとに分けて複数行（配列）で抽出してください。同一レシートである旨を備考欄に記載してください。以下のJSON配列形式のみで出力：[{"date": "YYYY-MM-DD", "store": "店舗名", "total": 金額数値, "tax": 消費税額数値, "category": "勘定科目", "regNo": "登録番号(Tから始まる番号,不明なら空欄)", "note": "備考(同一レシート結合・軽減税率等)"}]'
};

function logInfo(details) {
  // 画像・OCR結果・APIキーは絶対にログ出力しない。
  console.info('[RECEIPT_OCR]', JSON.stringify(details));
}

function jsonError(res, httpStatus, code, message, metrics) {
  logInfo({ ...metrics, result: 'error', code, httpStatus });
  return res.status(httpStatus).json({ error: message, code });
}

function normalizeJson(text) {
  const raw = String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const value = JSON.parse(raw);
  const rows = Array.isArray(value) ? value : [value];
  if (!rows.length || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error('Unexpected response shape');
  }
  if (rows.some(row => !('total' in row) || !('store' in row))) {
    throw new Error('Required OCR fields missing');
  }
  return value;
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function requestGemini(model, contents, apiKey, timeoutMs) {
  let response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: contents }],
          generationConfig: {
            responseMimeType: 'application/json',
            // Gemini 3.6 Flash: low、3.5 Flash-Lite: minimal。どちらも正式対応。
            thinkingConfig: { thinkingLevel: model === BACKUP_MODEL ? 'minimal' : 'low' }
          }
        }),
        signal: AbortSignal.timeout(timeoutMs)
      }
    );
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { success: false, retryable: true, providerStatus: null, code: timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_NETWORK' };
  }

  let data;
  try {
    data = await response.json();
  } catch (_) {
    return { success: false, retryable: response.status >= 500, providerStatus: response.status, code: 'UPSTREAM_BAD_JSON' };
  }

  if (!response.ok) {
    const status = response.status;
    // 429はAPI割当枠/課金条件の可能性があるため、モデルを切替えての再送はしない。
    const retryable = [408, 500, 502, 503, 504].includes(status);
    return { success: false, retryable, providerStatus: status, code: status === 429 ? 'UPSTREAM_RATE_LIMIT' : 'UPSTREAM_REJECTED' };
  }

  const text = (data?.candidates?.[0]?.content?.parts || [])
    .filter(part => typeof part?.text === 'string').map(part => part.text).join('');
  if (!text) return { success: false, retryable: false, providerStatus: 200, code: 'UPSTREAM_EMPTY' };
  try {
    return { success: true, data: normalizeJson(text), providerStatus: 200 };
  } catch (_) {
    return { success: false, retryable: false, providerStatus: 200, code: 'UPSTREAM_INVALID_OUTPUT' };
  }
}

export default async function handler(req, res) {
  const started = Date.now();
  const metrics = { imageCount: 0, payloadBytes: 0, attempts: 0, model: null, providerStatus: null };
  if (req.method !== 'POST') return jsonError(res, 405, 'METHOD_NOT_ALLOWED', 'POSTで送信してください。', metrics);

  let apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return jsonError(res, 500, 'MISSING_API_KEY', 'AI解析の設定がありません。管理者に確認してください。', metrics);
  apiKey = apiKey.trim().replace(/^["']|["']$/g, '');

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch (_) { return jsonError(res, 400, 'BAD_REQUEST_JSON', '送信データがJSON形式ではありません。', metrics); }

  const images = body?.images;
  if (!Array.isArray(images) || !images.length) return jsonError(res, 400, 'NO_IMAGES', '撮影画像がありません。', metrics);
  if (images.length > MAX_IMAGES) return jsonError(res, 400, 'TOO_MANY_IMAGES', '一度に送る画像が多すぎます。枚数を減らしてください。', metrics);
  const mode = body.mode === 'long' ? 'long' : 'normal';
  const parts = [{ text: PROMPTS[mode] }];
  metrics.imageCount = images.length;

  for (const image of images) {
    if (typeof image !== 'string') return jsonError(res, 400, 'BAD_IMAGE', '画像データの形式が不正です。', metrics);
    const match = image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/i);
    if (!match) return jsonError(res, 400, 'BAD_IMAGE', '画像データの形式が不正です。', metrics);
    metrics.payloadBytes += Buffer.byteLength(image, 'utf8');
    if (metrics.payloadBytes > MAX_BYTES) return jsonError(res, 413, 'IMAGE_TOO_LARGE', '画像の合計容量が大きすぎます。枚数を減らしてください。', metrics);
    parts.push({ inline_data: { mime_type: match[1].toLowerCase(), data: match[2] } });
  }

  // スマホ画面側は105秒で中断するため、通常2回合わせておよそ45秒以内を目標。
  // 長尺レシートのみ、1回あたりの許容時間を長めにする。
  const timeouts = mode === 'long' ? [30000, 30000] : [22000, 22000];
  for (const [index, model] of [PRIMARY_MODEL, BACKUP_MODEL].entries()) {
    metrics.model = model;
    metrics.attempts++;
    const response = await requestGemini(model, parts, apiKey, timeouts[index]);
    metrics.providerStatus = response.providerStatus;
    if (response.success) {
      logInfo({ ...metrics, elapsedMs: Date.now() - started, result: 'success' });
      return res.status(200).json(response.data);
    }

    metrics.lastCode = response.code;
    // 成功する見込みのある一時的障害でのみ、予備モデルに切替える。
    if (!response.retryable || index === 1) {
      const isQuota = response.code === 'UPSTREAM_RATE_LIMIT';
      const invalidOutput = response.code === 'UPSTREAM_INVALID_OUTPUT' || response.code === 'UPSTREAM_EMPTY';
      if (isQuota) return jsonError(res, 429, 'GEMINI_RATE_LIMIT', 'AIの利用制限に達しました。時間をおいて再度お試しください。画像は保持されています。', { ...metrics, elapsedMs: Date.now() - started });
      if (invalidOutput) return jsonError(res, 502, 'GEMINI_INVALID_RESULT', 'AIが読み取り結果を正しく返しませんでした。画像は保持されています。', { ...metrics, elapsedMs: Date.now() - started });
      // APIキー無効、未許可モデルなどの設定不備は無限に再試行しない。
      if (!response.retryable) return jsonError(res, 502, 'GEMINI_REQUEST_REJECTED', 'AIが解析要求を受け付けませんでした。API設定を確認してください。画像は保持されています。', { ...metrics, elapsedMs: Date.now() - started });
      return jsonError(res, 503, 'GEMINI_BUSY', 'AIサーバーが混雑しています。予備モデルでも解析できませんでした。画像は保持されています。', { ...metrics, elapsedMs: Date.now() - started });
    }
    // 予備モデルへの切替前に短い待機時間（過度な連打を防ぐ）。
    await delay(500 + Math.floor(Math.random() * 400));
  }
}
