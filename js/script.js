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

// OpenCV.js のグローバルコールバック
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
 * ぷよ認識のメインロジック
 */
function recognizePuyo(img) {
    const status = document.getElementById('status');
    status.innerText = '解析中...';

    try {
        let src = cv.imread('canvasInput');

        // 1. 画像のサイズを取得
        const width = src.cols;
        const height = src.rows;

        // 2. 盤面エリアの推定 (ぷよクエ標準レイアウト)
        // 縦 58% 〜 96% 付近が盤面。横はほぼ全域。
        const boardTop = Math.floor(height * 0.58);
        const boardBottom = Math.floor(height * 0.965);
        const boardLeft = Math.floor(width * 0.01);
        const boardRight = Math.floor(width * 0.99);

        const boardWidth = boardRight - boardLeft;
        const boardHeight = boardBottom - boardTop;

        const cellWidth = boardWidth / 8; // 横8列
        const cellHeight = boardHeight / 6; // 縦6行

        let boardResult = "";

        // HSV に変換して色を識別しやすくする
        let hsv = new cv.Mat();
        cv.cvtColor(src, hsv, cv.COLOR_RGBA2RGB);
        cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);

        // 3. 各セルをスキャン (行優先: 上から下の各行、左から右)
        let canvas = document.getElementById('canvasInput');
        let ctx = canvas.getContext('2d');
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.lineWidth = 2;
        ctx.font = 'bold 20px Arial';
        ctx.fillStyle = 'white';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (let row = 0; row < 6; row++) {
            for (let col = 0; col < 8; col++) {
                const x = boardLeft + col * cellWidth;
                const y = boardTop + row * cellHeight;
                const centerX = Math.floor(x + cellWidth / 2);
                const centerY = Math.floor(y + cellHeight / 2);

                // サンプリングエリア内の平均HSVを取得
                const result = detectPuyoType(hsv, centerX, centerY, Math.floor(cellWidth * 0.2));
                boardResult += result;

                // デバッグ用の枠と文字の描画
                ctx.strokeRect(x, y, cellWidth, cellHeight);
                ctx.fillText(result, centerX, centerY);
            }
        }

        // 4. ネクストの認識 (暫定で AAAAAAAA、座標は要調整)
        const nextResult = detectNextPuyos(hsv, width, height);

        generateUrl(nextResult, boardResult);

        hsv.delete();
        src.delete();

        status.innerText = '解析完了';
        status.className = 'status ready';
    } catch (err) {
        console.error(err);
        status.innerText = 'エラーが発生しました: ' + err.message;
        status.className = 'status error';
    }
}

/**
 * 特定の箇所のぷよの種類を判定する
 */
function detectPuyoType(hsv, cx, cy, radius) {
    // 中心付近のピクセルを取得
    let pixel = hsv.ucharPtr(cy, cx);
    let h = pixel[0]; // 0-180
    let s = pixel[1]; // 0-255
    let v = pixel[2]; // 0-255

    // 彩度が低い場合は「なし」または「おじゃま」など（今回は「なし」をAとする）
    if (s < 50) {
        if (v > 200) return PUYO_MAP['none']; // 白っぽい
        return PUYO_MAP['none'];
    }

    // HSVによる分岐 (簡易版)
    // 赤: 0-10, 170-180
    // 黄: 20-35
    // 緑: 40-90
    // 青: 100-130
    // 紫: 130-160
    // ハート: ピンク系 (160-170)

    let type = 'none';
    if (h < 10 || h > 170) type = 'red';
    else if (h >= 20 && h <= 35) type = 'yellow';
    else if (h >= 40 && h <= 90) type = 'green';
    else if (h >= 100 && h <= 130) type = 'blue';
    else if (h > 130 && h <= 160) type = 'purple';
    else if (h > 160 && h <= 170) type = 'heart';

    // プラスぷよの判定 (中心が非常に明るい、または周囲にプラスの形がある)
    // ここでは簡易的に V 値が高い（光っている）場合をプラスとする
    if (type !== 'none' && type !== 'heart' && v > 240) {
        return PUYO_MAP[type + '_plus'];
    }

    return PUYO_MAP[type] || 'A';
}

/**
 * ネクストぷよの認識
 */
function detectNextPuyos(hsv, width, height) {
    let nextResult = "";
    const ctx = document.getElementById('canvasInput').getContext('2d');

    // ネクストエリアの推定座標 (上部の5〜8枚並んでいるエリア)
    const nextTop = Math.floor(height * 0.12);
    const nextBottom = Math.floor(height * 0.18);
    const nextLeft = Math.floor(width * 0.15);
    const nextRight = Math.floor(width * 0.85);

    const nextWidth = nextRight - nextLeft;
    const cellWidth = nextWidth / 5; // 画面上に見えているのは5枚程度だが、URLは8枚分必要

    ctx.strokeStyle = 'cyan';

    for (let i = 0; i < 8; i++) {
        // 5枚目以降は画面外または重なっている可能性があるため暫定処理
        const col = i % 5;
        const row = Math.floor(i / 5);

        const centerX = Math.floor(nextLeft + (col + 0.5) * cellWidth);
        const centerY = Math.floor(nextTop + (row + 0.5) * (nextBottom - nextTop));

        if (i < 5) {
            const result = detectPuyoType(hsv, centerX, centerY, Math.floor(cellWidth * 0.2));
            nextResult += result;

            // デバッグ表示
            ctx.strokeRect(nextLeft + col * cellWidth, nextTop, cellWidth, nextBottom - nextTop);
            ctx.fillText(result, centerX, centerY);
        } else {
            nextResult += 'A'; // 6〜8枚目は暫定的に「なし」
        }
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
