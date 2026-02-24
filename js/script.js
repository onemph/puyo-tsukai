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
        // テンプレート画像のロード
        const templateImg = await new Promise((resolve, reject) => {
            const tImg = new Image();
            tImg.onload = () => resolve(tImg);
            tImg.onerror = () => reject(new Error('テンプレート画像 (assets/menu_template.png) の読み込みに失敗しました'));
            tImg.src = 'assets/menu_template.png';
        });

        let src = cv.imread('canvasInput');
        let templ = cv.imread(templateImg);

        status.innerText = '盤面を解析中...';

        // 座標の自動校正 (テンプレートマッチング)
        const coords = calibrateBoardCoordinates(src, templ);
        templ.delete(); // 使い終わったテンプレートを解放

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
        status.innerText = '解析エラー: ' + err.message;
        status.className = 'status error';
    }
}

/**
 * テンプレートマッチングを用いて座標を特定する (Ver.7: マルチスケール・テンプレートマッチング)
 */
function calibrateBoardCoordinates(src, templ) {
    const width = src.cols;
    const height = src.rows;

    let bestMaxVal = -1;
    let bestMaxPoint = null;
    let bestScale = -1;

    // 処理軽減のためグレースケール化
    let srcGray = new cv.Mat();
    cv.cvtColor(src, srcGray, cv.COLOR_RGBA2GRAY);

    // 1. スピードと精度のバランスを取るため、推定スケールの前後をスキャン
    const baseScale = width / 640;
    const testScales = [0.9, 0.95, 1.0, 1.05, 1.1].map(s => s * baseScale);

    for (let s of testScales) {
        let resizedTempl = new cv.Mat();
        let tw = Math.floor(templ.cols * s);
        let th = Math.floor(templ.rows * s);
        if (tw <= 0 || th <= 0) continue;

        cv.resize(templ, resizedTempl, new cv.Size(tw, th), 0, 0, cv.INTER_LINEAR);
        let templGray = new cv.Mat();
        cv.cvtColor(resizedTempl, templGray, cv.COLOR_RGBA2GRAY);

        let dst = new cv.Mat();
        let mask = new cv.Mat();
        cv.matchTemplate(srcGray, templGray, dst, cv.TM_CCOEFF_NORMED, mask);
        let result = cv.minMaxLoc(dst, mask);

        if (result.maxVal > bestMaxVal) {
            bestMaxVal = result.maxVal;
            bestMaxPoint = result.maxLoc;
            bestScale = s;
        }

        dst.delete(); mask.delete(); templGray.delete(); resizedTempl.delete();

        // 非常に高い一致が得られたら早期終了
        if (bestMaxVal > 0.98) break;
    }

    srcGray.delete();
    console.log("Multi-scale Template Match result:", { maxVal: bestMaxVal, scale: bestScale });

    // 閾値を下回る場合は解析不可
    if (bestMaxVal < 0.65) {
        return { auto: false };
    }

    // アンカー位置 (見つかったスケールにおけるMENUボタンの左上)
    const anchorX = bestMaxPoint.x;
    const anchorY = bestMaxPoint.y;

    // 盤面位置の計算 (MENUボタンからの相対距離)
    // 基準 (640px幅): MENU(28, 48), 盤面(10, 684) -> 相対 dx: -18, dy: +636
    // ※ ユーザーの切り抜きサイズ(113x48)に合わせて微調整
    const relLeft = -18;
    const relTop = 640;
    const relRight = 602;
    const relBottom = 1066;

    const boardLeft = anchorX + (relLeft * bestScale);
    const boardTop = anchorY + (relTop * bestScale);
    const boardRight = anchorX + (relRight * bestScale);
    const boardBottom = anchorY + (relBottom * bestScale);

    return {
        boardTop, boardBottom, boardLeft, boardRight,
        scale: bestScale,
        auto: true
    };
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
