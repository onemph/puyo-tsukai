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
 * ぷよ認識のメインロジック (自動座標校正 Ver.2)
 */
async function recognizePuyo(img) {
    const status = document.getElementById('status');
    status.innerText = '盤面を解析中...';

    try {
        let src = cv.imread('canvasInput');
        const width = src.cols;
        const height = src.rows;

        // HSV に変換
        let hsv = new cv.Mat();
        cv.cvtColor(src, hsv, cv.COLOR_RGBA2RGB);
        cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);

        // 1. 座標の自動校正 (HPバーやUIをスキャンして盤面位置を特定)
        const coords = calibrateBoardCoordinates(hsv);

        const { boardTop, boardBottom, boardLeft, boardRight, scale, auto } = coords;
        console.log("Calibrated coordinates:", coords);

        const boardWidth = boardRight - boardLeft;
        const boardHeight = boardBottom - boardTop;

        const cellWidth = boardWidth / 8; // 横8列
        const cellHeight = boardHeight / 6; // 縦6行

        let boardResult = "";

        // 2. 各セルをスキャン
        let canvas = document.getElementById('canvasInput');
        let ctx = canvas.getContext('2d');

        // 描画設定をスケールに合わせる
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

                // 多点サンプリングによる認識
                const result = detectPuyoMultiPoint(hsv, centerX, centerY, Math.floor(cellWidth * 0.3));
                boardResult += result;

                // デバッグ用の枠と文字
                ctx.strokeStyle = (result === 'A') ? 'red' : 'rgba(255, 255, 255, 0.8)';
                ctx.strokeRect(x, y, cellWidth, cellHeight);

                ctx.fillStyle = 'black';
                ctx.fillText(result, centerX + 1, centerY + 1);
                ctx.fillStyle = (result === 'A') ? '#ff4d4d' : 'white';
                ctx.fillText(result, centerX, centerY);

                // HSV情報の常時表示 (極小)
                let avg = getAverageHSV(hsv, centerX, centerY, 1);
                ctx.font = `${Math.floor(8 * scale)}px Arial`;
                ctx.fillStyle = 'yellow';
                ctx.fillText(`H${Math.floor(avg.h)} S${Math.floor(avg.s)}`, centerX, centerY + Math.floor(18 * scale));
                ctx.font = `bold ${fontSize}px Arial`;
            }
        }

        // 3. ネクストの認識
        const boardParams = { boardTop, boardLeft, cellWidth, cellHeight, scale };
        const nextResult = detectNextPuyos(hsv, width, height, boardParams);

        generateUrl(nextResult, boardResult);

        hsv.delete();
        src.delete();

        status.innerText = '解析完了 (' + (coords.auto ? '自動校正' : '標準') + ')';
        status.className = 'status ready';
    } catch (err) {
        console.error(err);
        status.innerText = '解析エラー: ' + err.message;
        status.className = 'status error';
    }
}

/**
 * 画像の内容から盤面の位置を自動的に特定する (Ver.5: 幅基準スケーリング)
 */
function calibrateBoardCoordinates(hsv) {
    const width = hsv.cols;
    const height = hsv.rows;

    // 基準幅 640px に対する現在の幅の比率
    const scaleX = width / 640;

    // デフォルト値 (比率ベースのフォールバック)
    let boardLeft = Math.floor(10 * scaleX);
    let boardRight = Math.floor(630 * scaleX);
    let boardTop = Math.floor(height * 0.605);
    let boardBottom = Math.floor(height * 0.98);
    let auto = false;

    // --- 1. 体力バー(緑色)を複数箇所でスキャンして盤面上部を特定する ---
    const scanLines = [0.2, 0.4, 0.6, 0.8].map(p => Math.floor(width * p));
    let foundHpBarY = -1;

    for (let y = Math.floor(height * 0.2); y < height * 0.8; y++) {
        for (let x of scanLines) {
            let pixel = hsv.ucharPtr(y, x);
            // 緑色の判定 (H: 35-95, S: 70+, V: 70+) - 範囲を少し広げて確実に捉える
            if (pixel[0] > 35 && pixel[0] < 95 && pixel[1] > 70 && pixel[2] > 70) {
                foundHpBarY = y;
                break;
            }
        }
        if (foundHpBarY !== -1) break;
    }

    if (foundHpBarY !== -1) {
        // 重要: オフセットは「高さ」ではなく「幅」に比例させる
        // 640x1136時の実測で約57px = 幅の約 8.9%
        const offset = Math.floor(width * 0.089);
        boardTop = foundHpBarY + offset;
        auto = true;
    }

    // --- 2. 下から上にスキャンして盤面下部を特定する ---
    let foundBottomY = -1;
    const midX = Math.floor(width / 2);
    // 画面の一番下からスキャンして、最初に何らかのオブジェクトが見つかる場所を探す
    for (let y = height - 5; y > boardTop + 100; y--) {
        let pixel = hsv.ucharPtr(y, midX);
        if (pixel[2] > 50) { // 明度が一定以上ある地点
            foundBottomY = y;
            break;
        }
    }
    if (foundBottomY !== -1) {
        boardBottom = foundBottomY;
        // 異常に長い場合は比率で補正 (8:6比率 * 余裕分)
        const expectedHeight = (boardRight - boardLeft) * (6 / 8) * 1.15;
        if (boardBottom - boardTop > expectedHeight) {
            boardBottom = boardTop + Math.floor(expectedHeight);
        }
    }

    // スケールの計算 (標準盤面高さ 426px に対する比)
    const refBoardHeight = 426;
    const currentBoardHeight = boardBottom - boardTop;
    let scale = currentBoardHeight / refBoardHeight;
    if (scale < 0.3 || scale > 5.0) scale = scaleX;

    return { boardTop, boardBottom, boardLeft, boardRight, scale, auto };
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
