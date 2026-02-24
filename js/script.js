/**
 * ぷよ認識 for puyosim
 * script.js
 */

const PUYOSIM_BASE_URL = "https://puyosim.com/new/";
const DEFAULT_OPTIONS = "-AAELBB";

// ぷよの種類と文字のマッピング
const PUYO_MAP = {
    'none': 'A',
    'red': 'B',
    'blue': 'C',
    'yellow': 'D',
    'green': 'E',
    'purple': 'F',
    'heart': 'G',
    'red_plus': 'R',
    'blue_plus': 'S',
    'yellow_plus': 'T',
    'green_plus': 'U',
    'purple_plus': 'V'
};

// OpenCV.js の準備完了を待機するためのポーリング
function checkOpenCvReady() {
    if (typeof cv !== 'undefined' && cv.ready) {
        cv.then(onOpenCvReady);
    } else if (typeof cv !== 'undefined' && cv.Mat) {
        onOpenCvReady();
    } else {
        setTimeout(checkOpenCvReady, 100);
    }
}

/**
 * OpenCV.js の準備完了を待機
 */
function onOpenCvReady() {
    const status = document.getElementById('status');
    const fileInput = document.getElementById('fileInput');

    status.innerText = '準備完了';
    status.className = 'status ready';
    fileInput.disabled = false;
}

// 初期化チェック開始
checkOpenCvReady();

// OpenCV.js のグローバルコールバック (保険)
var Module = {
    onRuntimeInitialized: onOpenCvReady
};

/**
 * 画像が選択された時の処理
 */
document.getElementById('fileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const img = new Image();
    img.onload = () => {
        const canvas = document.getElementById('canvasInput');
        const ctx = canvas.getContext('2d');
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);

        // 認識処理を開始
        recognizePuyo(img);
    };
    img.src = URL.createObjectURL(file);
});

/**
 * ぷよ認識のメインロジック (テンプレートマッチング Ver.1)
 */
async function recognizePuyo(img) {
    const status = document.getElementById('status');
    status.innerText = 'テンプレートを読み込み中...';

    try {
        // テンプレート画像のロード (MENUボタンとNEXTバー)
        const [menuImg, nextImg] = await Promise.all([
            new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => reject(new Error('assets/menu_template.png の読み込みに失敗しました'));
                img.src = 'assets/menu_template.png';
            }),
            new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => reject(new Error('assets/next_template.png の読み込みに失敗しました'));
                img.src = 'assets/next_template.png';
            })
        ]);

        let src = cv.imread('canvasInput');
        let tMenu = cv.imread(menuImg);
        let tNext = cv.imread(nextImg);

        status.innerText = '盤面を解析中...';

        // 座標の自動校正 (マルチスケール & マルチアンカー)
        const coords = calibrateBoardCoordinates(src, tMenu, tNext);
        tMenu.delete();
        tNext.delete();

        if (!coords.auto) {
            throw new Error("テンプレートマッチングに失敗しました。画像が正しくないか、テンプレートと一致しません。");
        }

        // HSV に変換 (判定用)
        let hsv = new cv.Mat();
        cv.cvtColor(src, hsv, cv.COLOR_RGBA2RGB);
        cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);

        const { boardTop, boardBottom, boardLeft, boardRight, scale } = coords;
        console.log("Calibrated coordinates (Template Match):", coords);

        const boardWidth = boardRight - boardLeft;
        const boardHeight = boardBottom - boardTop;

        const cellWidth = boardWidth / 8;
        const cellHeight = boardHeight / 6;

        let boardResult = "";

        let canvas = document.getElementById('canvasInput');
        let ctx = canvas.getContext('2d');

        const fontSize = Math.max(12, Math.floor(24 * scale));
        ctx.lineWidth = Math.max(1, 2 * scale);
        ctx.font = `bold ${fontSize}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (let row = 0; row < 6; row++) {
            for (let col = 0; col < 8; col++) {
                const x = boardLeft + col * cellWidth;
                const y = boardTop + row * cellHeight;
                const centerX = Math.floor(x + cellWidth / 2);
                const centerY = Math.floor(y + cellHeight / 2);

                const result = detectPuyoMultiPoint(hsv, centerX, centerY, Math.floor(cellWidth * 0.3));
                boardResult += result;

                ctx.strokeStyle = (result === 'A') ? 'red' : 'rgba(255, 255, 255, 0.8)';
                ctx.strokeRect(x, y, cellWidth, cellHeight);
                ctx.fillStyle = 'black';
                ctx.fillText(result, centerX + 1, centerY + 1);
                ctx.fillStyle = (result === 'A') ? '#ff4d4d' : 'white';
                ctx.fillText(result, centerX, centerY);
            }
        }

        const boardParams = { boardTop, boardLeft, cellWidth, cellHeight, scale };
        const nextResult = detectNextPuyos(hsv, src.cols, src.rows, boardParams);

        generateUrl(nextResult, boardResult);

        hsv.delete();
        src.delete();

        status.innerText = '解析完了 (テンプレート校正)';
        status.className = 'status ready';
    } catch (err) {
        console.error(err);
        // OpenCV.jsのエラーは文字列や数値の場合があるため、適切に表示
        let msg = err instanceof Error ? err.message : String(err);
        status.innerText = '解析エラー: ' + msg;
        status.className = 'status error';
    }
}

/**
 * テンプレートマッチングを用いて座標を特定する (Ver.8: マルチアンカー)
 */
function calibrateBoardCoordinates(src, tMenu, tNext) {
    const width = src.cols;
    const height = src.rows;

    // 1. まずMENUボタンで全体スケールを特定する (画面上部 30% を探す)
    let bestMenuMatch = findBestMatch(src, tMenu, [0.9, 1.0, 1.1], { y: 0, height: Math.floor(height * 0.3) });
    if (bestMenuMatch.maxVal < 0.6) {
        // 全体検索でフォールバック
        bestMenuMatch = findBestMatch(src, tMenu, [0.9, 1.0, 1.1]);
    }

    if (bestMenuMatch.maxVal < 0.6) return { auto: false };

    const scale = bestMenuMatch.scale;
    console.log("Anchor match result:", { menuVal: bestMenuMatch.maxVal, scale });

    // 2. NEXTバー（盤面直上のバー）を探す (画面中央〜下部 70% を探す)
    let bestNextMatch = findBestMatch(src, tNext, [1.0], { y: Math.floor(height * 0.3), height: Math.floor(height * 0.7) });

    // NEXTバーが見つかった場合
    if (bestNextMatch.maxVal > 0.6) {
        console.log("Next match found:", bestNextMatch.maxVal);
        const nx = bestNextMatch.maxPoint.x;
        const ny = bestNextMatch.maxPoint.y;
        const nh = tNext.rows * scale;

        // NEXTバーのすぐ下が盤面 (実測値に基づき微調整)
        // ユーザーフィードバックに基づき、全体的に少し下 (+4px) へ移動
        const boardTop = ny + nh + (2 * scale);
        const boardLeft = nx + (10 * scale);
        const boardRight = nx + (630 * scale);
        const boardBottom = boardTop + (430 * scale); // わずかに縦幅を広げる

        return { boardTop, boardBottom, boardLeft, boardRight, scale, auto: true };
    }

    // NEXTバーが見つからない場合のフォールバック（MENUからの相対位置）
    const anchorX = bestMenuMatch.maxPoint.x;
    const anchorY = bestMenuMatch.maxPoint.y;
    const relTop = 644; // 640 -> 644 (4px下に移動)
    const boardLeft = anchorX + (-18 * scale);
    const boardTop = anchorY + (relTop * scale);
    const boardRight = anchorX + (602 * scale);
    const boardBottom = boardTop + (430 * scale);

    return { boardTop, boardBottom, boardLeft, boardRight, scale, auto: true };
}

/**
 * 指定したスケール群から最適なマッチングを探すヘルパー
 * @param {cv.Mat} src 検索対象画像
 * @param {cv.Mat} templ テンプレート画像
 * @param {Array} relativeScales 試行する相対スケール ([0.9, 1.0, 1.1] など)
 * @param {Object} roi 検索範囲 {y, height} (省略時は全体)
 */
function findBestMatch(src, templ, relativeScales, roi = null) {
    let best = { maxVal: -1, maxPoint: null, scale: -1 };

    let searchArea = src;
    if (roi) {
        searchArea = src.roi(new cv.Rect(0, roi.y, src.cols, roi.height));
    }

    let srcGray = new cv.Mat();
    cv.cvtColor(searchArea, srcGray, cv.COLOR_RGBA2GRAY);

    const baseScale = src.cols / 640;
    for (let rs of relativeScales) {
        const s = rs * baseScale;
        let tw = Math.floor(templ.cols * s);
        let th = Math.floor(templ.rows * s);

        // テンプレートがソースより大きい場合はスキップ（OpenCVの例外回避）
        if (tw >= srcGray.cols || th >= srcGray.rows || tw <= 0 || th <= 0) continue;

        let resizedTempl = new cv.Mat();
        cv.resize(templ, resizedTempl, new cv.Size(tw, th), 0, 0, cv.INTER_LINEAR);
        let tGray = new cv.Mat();
        cv.cvtColor(resizedTempl, tGray, cv.COLOR_RGBA2GRAY);

        let dst = new cv.Mat();
        let mask = new cv.Mat();
        cv.matchTemplate(srcGray, tGray, dst, cv.TM_CCOEFF_NORMED, mask);
        let result = cv.minMaxLoc(dst, mask);

        if (result.maxVal > best.maxVal) {
            // ROIを使用している場合は座標をオフセット
            let point = { x: result.maxLoc.x, y: result.maxLoc.y + (roi ? roi.y : 0) };
            best = { maxVal: result.maxVal, maxPoint: point, scale: s };
        }

        dst.delete(); mask.delete(); tGray.delete(); resizedTempl.delete();
        if (best.maxVal > 0.99) break;
    }

    srcGray.delete();
    if (roi) searchArea.delete();

    return best;
}


/**
 * HSVの平均値を取得するヘルパー
 */
function getAverageHSV(hsv, cx, cy, range) {
    let totalH = 0, totalS = 0, totalV = 0;
    let count = 0;
    for (let dy = -range; dy <= range; dy++) {
        for (let dx = -range; dx <= range; dx++) {
            let py = cy + dy;
            let px = cx + dx;
            if (py >= 0 && py < hsv.rows && px >= 0 && px < hsv.cols) {
                let pixel = hsv.ucharPtr(py, px);
                totalH += pixel[0];
                totalS += pixel[1];
                totalV += pixel[2];
                count++;
            }
        }
    }
    return {
        h: totalH / (count || 1),
        s: totalS / (count || 1),
        v: totalV / (count || 1)
    };
}

/**
 * 多点サンプリングによるぷよ判定
 */
function detectPuyoMultiPoint(hsv, cx, cy, radius) {
    const points = [];
    const step = radius / 1.5;

    // 3x3 のグリッドでサンプリング
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            points.push(detectPuyoType(hsv, cx + dx * step, cy + dy * step));
        }
    }

    // 多数決 (A以外の最頻出を採用、同数の場合は距離の総和などで判定も可能だがまずはシンプルに)
    const counts = {};
    points.forEach(p => { counts[p] = (counts[p] || 0) + 1; });

    let bestType = 'A';
    let maxCount = 0;

    // なし(A)よりも色がある方を優先する
    for (const [type, count] of Object.entries(counts)) {
        if (type === 'A') continue;
        if (count > maxCount) {
            maxCount = count;
            bestType = type;
        }
    }

    // 色が優勢ならその色、そうでなければ A
    return (maxCount >= 3) ? bestType : 'A';
}

/**
 * 代表的な色のHSV値 (実機スクリーンショットに基づきさらに調整)
 */
const COLOR_TARGETS = {
    red: { h: 0, s: 130, v: 180 },
    blue: { h: 105, s: 130, v: 180 },
    yellow: { h: 25, s: 130, v: 180 },
    green: { h: 60, s: 130, v: 180 },
    purple: { h: 145, s: 100, v: 160 },
    heart: { h: 165, s: 110, v: 200 }
};

/**
 * 特定の箇所のぷよの種類を判定する (色距離法)
 */
function detectPuyoType(hsv, cx, cy) {
    const avg = getAverageHSV(hsv, cx, cy, 1);
    let h = avg.h;
    let s = avg.s;
    let v = avg.v;

    // 彩度が極端に低い場合は「なし」 (さらに緩和して 15)
    if (s < 15) return 'A';

    let minDist = Infinity;
    let closestType = 'none';

    for (const [type, target] of Object.entries(COLOR_TARGETS)) {
        let hDiff = Math.abs(h - target.h);
        if (hDiff > 90) hDiff = 180 - hDiff;

        // Hを最重視
        let dist = hDiff * 5 + Math.abs(s - target.s) * 0.3 + Math.abs(v - target.v) * 0.2;

        if (dist < minDist) {
            minDist = dist;
            closestType = type;
        }
    }

    // 距離が遠すぎる場合は A (閾値を 150 に緩和)
    if (minDist > 150) return 'A';

    return PUYO_MAP[closestType] || 'A';
}

/**
 * ネクストぷよの認識 (盤面のすぐ上の1行 8小をスキャン)
 */
function detectNextPuyos(hsv, width, height, boardParams) {
    let nextResult = "";
    const ctx = document.getElementById('canvasInput').getContext('2d');
    const { boardTop, boardLeft, cellWidth, cellHeight, scale } = boardParams;

    // 盤面のすぐ上、1行分をネクストエリアとする (高さは盤面の 55% 程度)
    const nextCellHeight = cellHeight * 0.55;
    const nextBottom = boardTop - Math.floor(cellHeight * 0.08); // 盤面との微小な隙間
    const nextTop = nextBottom - Math.floor(nextCellHeight);

    ctx.strokeStyle = 'cyan';
    ctx.lineWidth = 2;

    for (let i = 0; i < 8; i++) {
        const x = boardLeft + i * cellWidth;
        const centerX = Math.floor(x + cellWidth / 2);
        const centerY = Math.floor(nextTop + nextCellHeight / 2);

        // 多点サンプリングを適用 (半径はセル幅の 20%)
        const result = detectPuyoMultiPoint(hsv, centerX, centerY, Math.floor(cellWidth * 0.2));
        nextResult += result;

        // デバッグ表示
        ctx.strokeRect(x, nextTop, cellWidth, nextCellHeight);

        // 結果表示 (小さく)
        ctx.font = `bold ${Math.floor(16 * scale)}px Arial`;
        ctx.fillStyle = 'black';
        ctx.fillText(result, centerX + 1, centerY + 1);
        ctx.fillStyle = (result === 'A') ? '#00ffff' : 'white';
        ctx.fillText(result, centerX, centerY);

        // HSV表示
        let avg = getAverageHSV(hsv, centerX, centerY, 1);
        ctx.font = `${Math.floor(8 * scale)}px Arial`;
        ctx.fillStyle = 'cyan';
        ctx.fillText(`H${Math.floor(avg.h)} S${Math.floor(avg.s)}`, centerX, centerY + Math.floor(12 * scale));
    }

    return nextResult;
}

/**
 * puyosim.com の URL を生成して表示
 */
function generateUrl(next, board) {
    const resultUrl = `${PUYOSIM_BASE_URL}${next}_${board}${DEFAULT_OPTIONS}`;

    const resultArea = document.getElementById('resultArea');
    const resultInput = document.getElementById('resultUrl');
    const puyoSimLink = document.getElementById('puyoSimLink');

    resultInput.value = resultUrl;
    puyoSimLink.href = resultUrl;
    resultArea.style.display = 'block';
}

/**
 * コピーボタンの処理
 */
document.getElementById('copyBtn').addEventListener('click', () => {
    const resultInput = document.getElementById('resultUrl');
    resultInput.select();
    document.execCommand('copy');
    alert('URLをコピーしました');
});
