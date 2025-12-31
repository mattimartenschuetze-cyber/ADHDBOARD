// ========== INITIALIZATION ==========
const socket = io();
const canvas = document.getElementById('paper');
const ctx = canvas.getContext('2d');
const container = document.getElementById('canvas-container');
const colorPicker = document.getElementById('colorPicker');
const colorPreview = document.getElementById('colorPreview');

let currentRoom = 1;
let paths = [];
let highlighterPaths = []; // Separate array for temporary highlighter marks
let laserPaths = []; // Temporary laser pointer paths
let currentPath = null;
let currentTool = 'pen';
let brushSize = 3;
let currentBackground = 'dots';
let textSize = 18;
let markerOpacity = 0.3; // Default marker transparency
let animationSpeed = 1.0; // Animation speed multiplier (1.0 = normal)
let enableAnimation = true; // Keep animations enabled, just optimize them
let offset = { x: 0, y: 0 };

// Detect mobile devices
function isMobileDevice() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
           (navigator.maxTouchPoints && navigator.maxTouchPoints > 2);
}
let scale = 1;
let isPanning = false;
let unreadCount = 0;
let dpr = window.devicePixelRatio || 1;

// Image manipulation
let selectedImage = null;
let isDraggingImage = false;
let isResizingImage = false;
let isErasing = false;
let resizeHandle = null;
let dragStartPos = { x: 0, y: 0 };
let imageStartPos = { x: 0, y: 0 };
let imageStartSize = { width: 0, height: 0 };
let lastTapTime = 0;
let touchStartTime = 0;
let touchStartPos = { x: 0, y: 0 };

// Ping Pong paddle dragging
let isDraggingPaddle = false;
let draggedPaddleGame = null;
let draggedPaddleSide = null; // 'left' or 'right'

// Multi-touch
let touches = [];

// Eraser cursor
let eraserCursor = null;

// Track if we're the one sending updates
let isLocalUpdate = false;

// Apple Pencil detection
let isApplePencil = false;

// Render throttling for performance
let renderScheduled = false;
let lastRenderTime = 0;
const minRenderInterval = isMobileDevice() ? 32 : 16; // 30fps mobile, 60fps desktop

socket.emit('join_room', currentRoom);

// ========== SOCKET EVENTS (Must be after join_room) ==========
socket.on('canvas_data', (data) => {
    console.log('📥 Received canvas_data with', data.length, 'elements');

    if (isLocalUpdate) {
        console.log('   🔒 Ignoring own update');
        return;
    }

    console.log('   🌐 Applying remote update');

    // Count and log element types for debugging
    const types = {};
    data.forEach((el, index) => {
        types[el.type] = (types[el.type] || 0) + 1;
        if (el.type === 'game') {
            console.log('   🎮 Game found:', el.gameType, 'at', el.x, el.y);
            
            // Start Ping Pong game loop if needed
            if (el.gameType === 'pingpong' && el.gameStarted && !el.winner && !pingPongLoops[index]) {
                startPingPongLoop(index);
            }
        }
    });
    console.log('   📊 Element types:', types);

    paths = data;

    if (!isDraggingImage && !isResizingImage) {
        selectedImage = null;
    }

    render();
});

socket.on('element_received', (el) => {
    console.log('📥 Received new element:', el.type);

    // Only animate on desktop for performance
    if (enableAnimation && el.type === 'line' && el.points && el.points.length > 1) {
        // Animate drawing for line paths
        console.log('🎬 Starting animated playback with', el.points.length, 'points');
        animateDrawing(el);
    } else {
        // No animation - just add immediately
        const newIndex = paths.length;
        paths.push(el);
        
        // Start Ping Pong game loop if it's a new ping pong game
        if (el.type === 'game' && el.gameType === 'pingpong' && el.gameStarted && !el.winner) {
            startPingPongLoop(newIndex);
        }
        
        render();
    }
});

// ========== ANIMATED DRAWING PLAYBACK ==========
let currentlyAnimating = []; // Track which paths are currently animating

// ========== SHAPE RECOGNITION ==========
function recognizeShape(path) {
    if (!path.points || path.points.length < 10) {
        return null; // Too few points
    }

    const points = path.points;
    const firstPoint = points[0];
    const lastPoint = points[points.length - 1];

    // Calculate distance between first and last point
    const closedDistance = Math.hypot(lastPoint.x - firstPoint.x, lastPoint.y - firstPoint.y);
    const isClosed = closedDistance < 50; // Consider closed if within 50px

    // Calculate bounding box
    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const width = maxX - minX;
    const height = maxY - minY;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    // Calculate aspect ratio
    const aspectRatio = width / height;
    const isSquarish = aspectRatio > 0.8 && aspectRatio < 1.2;

    // Detect if it's a straight line
    if (isLineShape(points)) {
        console.log('📏 Detected: LINE');
        return {
            type: 'shape',
            shapeType: 'line',
            color: path.color,
            brushSize: path.brushSize,
            points: [firstPoint, lastPoint] // Simplified to 2 points
        };
    }

    // Detect rectangle/square FIRST (before circles)
    if (isClosed && hasRectangleShape(points, minX, maxX, minY, maxY)) {
        console.log('▢ Detected: RECTANGLE');
        return {
            type: 'shape',
            shapeType: isSquarish ? 'square' : 'rectangle',
            color: path.color,
            brushSize: path.brushSize,
            x: minX,
            y: minY,
            width: width,
            height: height
        };
    }

    // Detect triangle BEFORE circles
    if (isClosed && hasTriangleShape(points)) {
        console.log('▲ Detected: TRIANGLE');
        const corners = findCorners(points, 3);
        if (corners.length >= 3) {
            return {
                type: 'shape',
                shapeType: 'triangle',
                color: path.color,
                brushSize: path.brushSize,
                points: corners.slice(0, 3)
            };
        }
    }

    // Detect circle/ellipse LAST (most permissive)
    if (isClosed && points.length > 20) {
        const avgRadius = calculateAverageRadius(points, centerX, centerY);
        const radiusVariance = calculateRadiusVariance(points, centerX, centerY, avgRadius);

        if (radiusVariance < 0.15) { // Stricter: only very round shapes
            console.log('⭕ Detected: CIRCLE');
            return {
                type: 'shape',
                shapeType: 'circle',
                color: path.color,
                brushSize: path.brushSize,
                x: centerX,
                y: centerY,
                radius: avgRadius
            };
        } else if (radiusVariance < 0.3) { // Stricter: medium variance = ellipse
            console.log('🥚 Detected: ELLIPSE');
            return {
                type: 'shape',
                shapeType: 'ellipse',
                color: path.color,
                brushSize: path.brushSize,
                x: centerX,
                y: centerY,
                radiusX: width / 2,
                radiusY: height / 2
            };
        }
    }

    // If no shape recognized, return original
    return null;
}

function isLineShape(points) {
    if (points.length < 5) return true;

    const firstPoint = points[0];
    const lastPoint = points[points.length - 1];
    const lineLength = Math.hypot(lastPoint.x - firstPoint.x, lastPoint.y - firstPoint.y);

    // Calculate average deviation from straight line
    let totalDeviation = 0;
    for (let i = 1; i < points.length - 1; i++) {
        const deviation = pointToLineDistance(points[i], firstPoint, lastPoint);
        totalDeviation += deviation;
    }
    const avgDeviation = totalDeviation / (points.length - 2);

    return avgDeviation < 20; // Consider it a line if deviation is small
}

function pointToLineDistance(point, lineStart, lineEnd) {
    const A = point.x - lineStart.x;
    const B = point.y - lineStart.y;
    const C = lineEnd.x - lineStart.x;
    const D = lineEnd.y - lineStart.y;

    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    const param = lenSq !== 0 ? dot / lenSq : -1;

    let xx, yy;
    if (param < 0) {
        xx = lineStart.x;
        yy = lineStart.y;
    } else if (param > 1) {
        xx = lineEnd.x;
        yy = lineEnd.y;
    } else {
        xx = lineStart.x + param * C;
        yy = lineStart.y + param * D;
    }

    return Math.hypot(point.x - xx, point.y - yy);
}

function calculateAverageRadius(points, centerX, centerY) {
    let sum = 0;
    for (let p of points) {
        sum += Math.hypot(p.x - centerX, p.y - centerY);
    }
    return sum / points.length;
}

function calculateRadiusVariance(points, centerX, centerY, avgRadius) {
    let variance = 0;
    for (let p of points) {
        const radius = Math.hypot(p.x - centerX, p.y - centerY);
        variance += Math.abs(radius - avgRadius) / avgRadius;
    }
    return variance / points.length;
}

function hasCorners(points, expectedCorners) {
    const corners = findCorners(points, expectedCorners);
    return corners.length === expectedCorners;
}

function hasRectangleShape(points, minX, maxX, minY, maxY) {
    // Check if the points mostly cluster around the rectangle edges
    const corners = findCorners(points, 4);
    if (corners.length !== 4) return false;

    // Check if corners form approximately 90-degree angles
    let rightAngles = 0;
    for (let i = 0; i < 4; i++) {
        const prev = corners[(i + 3) % 4];
        const curr = corners[i];
        const next = corners[(i + 1) % 4];

        const angle1 = Math.atan2(curr.y - prev.y, curr.x - prev.x);
        const angle2 = Math.atan2(next.y - curr.y, next.x - curr.x);
        let angleDiff = Math.abs(angle2 - angle1);

        // Normalize angle
        if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;

        // Check if close to 90 degrees (π/2)
        if (Math.abs(angleDiff - Math.PI / 2) < 0.5) {
            rightAngles++;
        }
    }

    // If at least 3 corners are right angles, it's probably a rectangle
    return rightAngles >= 3;
}

function hasTriangleShape(points) {
    const corners = findCorners(points, 3);
    if (corners.length !== 3) return false;

    // Check if three corners form a reasonable triangle
    const [p1, p2, p3] = corners;
    const d12 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const d23 = Math.hypot(p3.x - p2.x, p3.y - p2.y);
    const d31 = Math.hypot(p1.x - p3.x, p1.y - p3.y);

    // Check triangle inequality (all sides must be reasonable length)
    if (d12 < 20 || d23 < 20 || d31 < 20) return false;
    if (d12 + d23 <= d31 || d23 + d31 <= d12 || d31 + d12 <= d23) return false;

    return true;
}

function findCorners(points, expectedCorners) {
    // Improved corner detection using angle changes
    const cornerCandidates = [];
    const threshold = 0.7; // Larger threshold = sharper angles required (about 40 degrees)
    const minDistance = 50; // Minimum distance between corners

    for (let i = 15; i < points.length - 15; i += 5) {
        const prev = points[i - 15];
        const curr = points[i];
        const next = points[i + 15];

        const angle1 = Math.atan2(curr.y - prev.y, curr.x - prev.x);
        const angle2 = Math.atan2(next.y - curr.y, next.x - curr.x);
        let angleDiff = Math.abs(angle2 - angle1);

        // Normalize angle to [0, π]
        if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;

        // Detect significant direction change (corner)
        if (angleDiff > threshold && angleDiff < Math.PI - threshold) {
            cornerCandidates.push({
                point: curr,
                angle: angleDiff,
                index: i
            });
        }
    }

    // Filter corners that are too close together
    const filteredCorners = [];
    cornerCandidates.sort((a, b) => b.angle - a.angle); // Sort by angle (sharpest first)

    for (let candidate of cornerCandidates) {
        let tooClose = false;
        for (let existing of filteredCorners) {
            const dist = Math.hypot(
                candidate.point.x - existing.point.x,
                candidate.point.y - existing.point.y
            );
            if (dist < minDistance) {
                tooClose = true;
                break;
            }
        }

        if (!tooClose) {
            filteredCorners.push(candidate);
        }

        if (filteredCorners.length >= expectedCorners) break;
    }

    // Sort corners by position (clockwise from top-left)
    const corners = filteredCorners.map(c => c.point);
    if (corners.length > 0) {
        const centerX = corners.reduce((sum, p) => sum + p.x, 0) / corners.length;
        const centerY = corners.reduce((sum, p) => sum + p.y, 0) / corners.length;

        corners.sort((a, b) => {
            const angleA = Math.atan2(a.y - centerY, a.x - centerX);
            const angleB = Math.atan2(b.y - centerY, b.x - centerX);
            return angleA - angleB;
        });
    }

    return corners;
}

function animateDrawing(element) {
    const animatedPath = {
        ...element,
        points: [], // Start with empty points
        _isAnimating: true,
        _animationProgress: 0
    };

    // Add to paths array and animation tracker
    const pathIndex = paths.length;
    paths.push(animatedPath);
    currentlyAnimating.push(pathIndex);

    const totalPoints = element.points.length;
    const baseDuration = 500; // Faster: 0.5 seconds (was 0.8)
    const animationDuration = baseDuration / animationSpeed;

    // Add more points per frame for smoother, faster animation
    const targetFrameRate = isMobileDevice() ? 30 : 60; // Lower FPS on mobile
    const totalFrames = (animationDuration / 1000) * targetFrameRate;
    const pointsPerFrame = Math.max(2, Math.ceil(totalPoints / totalFrames)); // Min 2 points/frame

    let currentIndex = 0;
    const startTime = Date.now();

    function addNextPoints() {
        if (currentIndex >= totalPoints) {
            // Animation complete
            animatedPath._isAnimating = false;
            currentlyAnimating = currentlyAnimating.filter(i => i !== pathIndex);
            console.log('✅ Animation complete');
            render(); // Final render without cursor
            return;
        }

        // Add multiple points per frame for smoother animation
        const endIndex = Math.min(currentIndex + pointsPerFrame, totalPoints);
        for (let i = currentIndex; i < endIndex; i++) {
            animatedPath.points.push(element.points[i]);
        }

        currentIndex = endIndex;
        animatedPath._animationProgress = currentIndex / totalPoints;

        render();

        // Continue animation
        requestAnimationFrame(addNextPoints);
    }

    // Start animation
    requestAnimationFrame(addNextPoints);
}

socket.on('chat_received', (data) => {
    if (document.getElementById('chat-sidebar').classList.contains('closed')) {
        unreadCount++;
        updateBadge();
    }
    addMessageToUI('Anderer', data.text, 'msg-remote');
});

socket.on('chat_history', (history) => {
    document.getElementById('chat-messages').innerHTML = '';
    history.forEach(msg => addMessageToUI('Anderer', msg.text, 'msg-remote'));
});

// Receive laser pointer from other users
socket.on('laser_received', (laser) => {
    console.log('📥 Received laser pointer from another user');
    laserPaths.push(laser);
    render();
});

// Receive background updates from server
socket.on('background_updated', (background) => {
    console.log('📥 Background updated:', background);
    currentBackground = background;
    document.querySelectorAll('.bg-option').forEach(o => o.classList.remove('active'));
    const option = document.querySelector(`.bg-option[data-bg="${background}"]`);
    if (option) option.classList.add('active');
    render();
});

// Receive game moves from other players
socket.on('game_move_received', (data) => {
    console.log('🎮 Game move received from other player:', {
        gameIndex: data.gameIndex,
        currentPlayer: data.game.currentPlayer,
        board: data.game.board,
        winner: data.game.winner
    });

    if (data.gameIndex !== undefined && paths[data.gameIndex]) {
        // Update the game state completely
        paths[data.gameIndex] = {
            ...paths[data.gameIndex],
            ...data.game
        };
        console.log('✅ Game state updated at index', data.gameIndex);
        render();
    } else {
        console.error('❌ Could not find game at index', data.gameIndex);
    }
});

// ========== COLOR PICKER ==========
colorPicker.addEventListener('change', updateColorPreview);
updateColorPreview();

function updateColorPreview() {
    colorPreview.style.backgroundColor = colorPicker.value;
}

// ========== BRUSH SIZE ==========
const brushSizeSlider = document.getElementById('brushSize');
const brushPreview = document.getElementById('brushPreview');
const brushSizeValue = document.getElementById('brushSizeValue');

brushSizeSlider.addEventListener('input', (e) => {
    brushSize = parseFloat(e.target.value);
    brushSizeValue.textContent = brushSize;
    brushPreview.querySelector('::before') || (brushPreview.style.setProperty('--brush-size', brushSize + 'px'));
    brushPreview.innerHTML = `<div style="width: ${brushSize * 2}px; height: ${brushSize * 2}px; background: var(--ig-primary); border-radius: 50%;"></div>`;

    // Update slider gradient
    const percent = ((brushSize - 1) / 19) * 100;
    e.target.style.background = `linear-gradient(to right, var(--ig-blue) 0%, var(--ig-blue) ${percent}%, #e0e0e0 ${percent}%, #e0e0e0 100%)`;
});

// Text size slider
const textSizeSlider = document.getElementById('textSize');
const textSizePreview = document.getElementById('textSizePreview');
const textSizeValue = document.getElementById('textSizeValue');

textSizeSlider.addEventListener('input', (e) => {
    textSize = parseInt(e.target.value);
    textSizeValue.textContent = textSize;
    textSizePreview.style.fontSize = textSize + 'px';

    // Update slider gradient
    const percent = ((textSize - 12) / 36) * 100;
    e.target.style.background = `linear-gradient(to right, var(--ig-blue) 0%, var(--ig-blue) ${percent}%, #e0e0e0 ${percent}%, #e0e0e0 100%)`;
});

// Marker opacity slider
const markerOpacitySlider = document.getElementById('markerOpacity');
const opacityPreview = document.getElementById('opacityPreview');
const opacityValue = document.getElementById('opacityValue');

markerOpacitySlider.addEventListener('input', (e) => {
    markerOpacity = parseFloat(e.target.value);
    opacityValue.textContent = Math.round(markerOpacity * 100);
    opacityPreview.style.opacity = markerOpacity;

    // Update slider gradient
    const percent = ((markerOpacity - 0.1) / 0.9) * 100;
    e.target.style.background = `linear-gradient(to right, var(--ig-blue) 0%, var(--ig-blue) ${percent}%, #e0e0e0 ${percent}%, #e0e0e0 100%)`;
});

function toggleBrushSizeMenu() {
    const menu = document.getElementById('brushSizeMenu');
    const bgMenu = document.getElementById('backgroundMenu');
    bgMenu.style.display = 'none';
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

function toggleBackgroundMenu() {
    const menu = document.getElementById('backgroundMenu');
    const brushMenu = document.getElementById('brushSizeMenu');
    const gamesMenu = document.getElementById('gamesMenu');
    brushMenu.style.display = 'none';
    gamesMenu.style.display = 'none';
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

function toggleGamesMenu() {
    const menu = document.getElementById('gamesMenu');
    const brushMenu = document.getElementById('brushSizeMenu');
    const bgMenu = document.getElementById('backgroundMenu');
    brushMenu.style.display = 'none';
    bgMenu.style.display = 'none';
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

// Game placement state
let pendingGame = null;

function selectGame(gameType) {
    console.log('🎮 Selected game:', gameType);
    pendingGame = gameType;
    document.getElementById('gamesMenu').style.display = 'none';
    canvas.style.cursor = 'crosshair';
}

// Close menus when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('#brushSizeMenu') && !e.target.closest('[onclick*="toggleBrushSizeMenu"]')) {
        document.getElementById('brushSizeMenu').style.display = 'none';
    }
    if (!e.target.closest('#backgroundMenu') && !e.target.closest('[onclick*="toggleBackgroundMenu"]')) {
        document.getElementById('backgroundMenu').style.display = 'none';
    }
    if (!e.target.closest('#gamesMenu') && !e.target.closest('[onclick*="toggleGamesMenu"]') && !e.target.closest('.game-option')) {
        document.getElementById('gamesMenu').style.display = 'none';
    }
});

// Background selection
document.querySelectorAll('.bg-option').forEach(option => {
    option.addEventListener('click', () => {
        document.querySelectorAll('.bg-option').forEach(o => o.classList.remove('active'));
        option.classList.add('active');
        currentBackground = option.dataset.bg;

        // Sync background to server
        console.log('📤 Sending background change:', currentBackground);
        socket.emit('background_change', { room: currentRoom, background: currentBackground });

        render();
        document.getElementById('backgroundMenu').style.display = 'none';
    });
});

// Set default active background
document.querySelector('.bg-option[data-bg="dots"]').classList.add('active');

// ========== CANVAS INITIALIZATION ==========
function init() {
    dpr = window.devicePixelRatio || 1;
    
    // Force proper container dimensions
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    
    console.log('📐 Initializing canvas: ', w, 'x', h, 'DPR:', dpr);
    
    // Set canvas size
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    
    // Initialize offset to show top-left of virtual canvas
    // This ensures drawing area starts at the top of the visible viewport
    if (offset.x === 0 && offset.y === 0 && paths.length === 0) {
        offset.x = 0;
        offset.y = 0;
        console.log('📍 Canvas offset initialized to:', offset);
    }
    
    render();
}

// ========== BACKGROUND DRAWING ==========
function drawBackground() {
    // Use actual canvas dimensions for background
    const canvasWidth = canvas.width / dpr;
    const canvasHeight = canvas.height / dpr;
    
    // Expand background area to cover panned/zoomed view
    const expandedWidth = canvasWidth / scale + Math.abs(offset.x / scale) * 2;
    const expandedHeight = canvasHeight / scale + Math.abs(offset.y / scale) * 2;
    const startX = -Math.abs(offset.x / scale);
    const startY = -Math.abs(offset.y / scale);

    switch(currentBackground) {
        case 'white':
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(startX, startY, expandedWidth, expandedHeight);
            break;

        case 'dots':
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(startX, startY, expandedWidth, expandedHeight);
            ctx.fillStyle = '#e0e0e0';
            for(let x = Math.floor(startX / 30) * 30; x < startX + expandedWidth; x += 30) {
                for(let y = Math.floor(startY / 30) * 30; y < startY + expandedHeight; y += 30) {
                    ctx.beginPath();
                    ctx.arc(x, y, 2, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
            break;

        case 'grid':
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(startX, startY, expandedWidth, expandedHeight);
            ctx.strokeStyle = '#e0e0e0';
            ctx.lineWidth = 1;
            for(let x = Math.floor(startX / 30) * 30; x < startX + expandedWidth; x += 30) {
                ctx.beginPath();
                ctx.moveTo(x, startY);
                ctx.lineTo(x, startY + expandedHeight);
                ctx.stroke();
            }
            for(let y = Math.floor(startY / 30) * 30; y < startY + expandedHeight; y += 30) {
                ctx.beginPath();
                ctx.moveTo(startX, y);
                ctx.lineTo(startX + expandedWidth, y);
                ctx.stroke();
            }
            break;

        case 'lines':
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(startX, startY, expandedWidth, expandedHeight);
            ctx.strokeStyle = '#e0e0e0';
            ctx.lineWidth = 1;
            for(let y = Math.floor(startY / 30) * 30; y < startY + expandedHeight; y += 30) {
                ctx.beginPath();
                ctx.moveTo(startX, y);
                ctx.lineTo(startX + expandedWidth, y);
                ctx.stroke();
            }
            break;

        case 'dark':
            ctx.fillStyle = '#1a1a1a';
            ctx.fillRect(startX, startY, expandedWidth, expandedHeight);
            break;

        case 'blueprint':
            ctx.fillStyle = '#1e3a5f';
            ctx.fillRect(startX, startY, expandedWidth, expandedHeight);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
            ctx.lineWidth = 1;
            for(let x = Math.floor(startX / 30) * 30; x < startX + expandedWidth; x += 30) {
                ctx.beginPath();
                ctx.moveTo(x, startY);
                ctx.lineTo(x, startY + expandedHeight);
                ctx.stroke();
            }
            for(let y = Math.floor(startY / 30) * 30; y < startY + expandedHeight; y += 30) {
                ctx.beginPath();
                ctx.moveTo(startX, y);
                ctx.lineTo(startX + expandedWidth, y);
                ctx.stroke();
            }
            break;
    }
}

// ========== RENDERING ==========
function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);
    ctx.save();
    ctx.translate(offset.x, offset.y);
    ctx.scale(scale, scale);

    // Draw background based on current selection
    drawBackground();

    // Render all paths
    paths.forEach((p, index) => {
        ctx.fillStyle = p.color || "#000";
        ctx.strokeStyle = p.color || "#000";

        if (p.type === 'game' && p.gameType === 'tictactoe') {
            // Render Tic Tac Toe game
            const cellSize = p.size / 3;

            // Draw board background
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(p.x, p.y, p.size, p.size);

            // Draw grid lines
            ctx.strokeStyle = '#333';
            ctx.lineWidth = 3;

            // Vertical lines
            for (let i = 1; i < 3; i++) {
                ctx.beginPath();
                ctx.moveTo(p.x + i * cellSize, p.y);
                ctx.lineTo(p.x + i * cellSize, p.y + p.size);
                ctx.stroke();
            }

            // Horizontal lines
            for (let i = 1; i < 3; i++) {
                ctx.beginPath();
                ctx.moveTo(p.x, p.y + i * cellSize);
                ctx.lineTo(p.x + p.size, p.y + i * cellSize);
                ctx.stroke();
            }

            // Draw X and O
            ctx.lineWidth = 8;
            ctx.lineCap = 'round';

            for (let row = 0; row < 3; row++) {
                for (let col = 0; col < 3; col++) {
                    const cellIndex = row * 3 + col;
                    const mark = p.board[cellIndex];

                    if (mark) {
                        const cx = p.x + col * cellSize + cellSize / 2;
                        const cy = p.y + row * cellSize + cellSize / 2;
                        const padding = cellSize * 0.2;

                        if (mark === 'X') {
                            // Draw X
                            ctx.strokeStyle = '#e74c3c';
                            ctx.beginPath();
                            ctx.moveTo(cx - padding, cy - padding);
                            ctx.lineTo(cx + padding, cy + padding);
                            ctx.moveTo(cx + padding, cy - padding);
                            ctx.lineTo(cx - padding, cy + padding);
                            ctx.stroke();
                        } else if (mark === 'O') {
                            // Draw O
                            ctx.strokeStyle = '#3498db';
                            ctx.beginPath();
                            ctx.arc(cx, cy, padding, 0, Math.PI * 2);
                            ctx.stroke();
                        }
                    }
                }
            }

            // Draw winner line
            if (p.winner && p.winner !== 'Draw' && p.winLine) {
                ctx.strokeStyle = '#27ae60';
                ctx.lineWidth = 6;
                ctx.globalAlpha = 0.8;

                const [a, b, c] = p.winLine;
                const rowA = Math.floor(a / 3);
                const colA = a % 3;
                const rowC = Math.floor(c / 3);
                const colC = c % 3;

                const x1 = p.x + colA * cellSize + cellSize / 2;
                const y1 = p.y + rowA * cellSize + cellSize / 2;
                const x2 = p.x + colC * cellSize + cellSize / 2;
                const y2 = p.y + rowC * cellSize + cellSize / 2;

                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();
                ctx.globalAlpha = 1.0;
            }

            // Draw status text
            ctx.fillStyle = '#333';
            ctx.font = 'bold 24px -apple-system, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';

            if (p.winner) {
                if (p.winner === 'Draw') {
                    ctx.fillText('Unentschieden!', p.x + p.size / 2, p.y + p.size + 10);
                } else {
                    ctx.fillText(`${p.winner} gewinnt! 🏆`, p.x + p.size / 2, p.y + p.size + 10);
                }
            } else {
                // Show whose turn it is
                let statusText = `Spieler ${p.currentPlayer} ist dran`;

                // Add indicator if it's your turn
                const isMyTurn = (p.currentPlayer === 'X' && socket.id === p.playerX) ||
                                 (p.currentPlayer === 'O' && socket.id === p.playerO);

                if (isMyTurn) {
                    statusText += ' (Du! 👆)';
                    ctx.fillStyle = '#27ae60'; // Green for your turn
                }

                ctx.fillText(statusText, p.x + p.size / 2, p.y + p.size + 10);

                // Show player assignments in smaller text
                ctx.font = '16px -apple-system, sans-serif';
                ctx.fillStyle = '#666';
                const youAreX = socket.id === p.playerX;
                const youAreO = socket.id === p.playerO;

                if (youAreX) {
                    ctx.fillText('Du bist X (Rot)', p.x + p.size / 2, p.y + p.size + 40);
                } else if (youAreO) {
                    ctx.fillText('Du bist O (Blau)', p.x + p.size / 2, p.y + p.size + 40);
                } else if (!p.playerO) {
                    ctx.fillText('Warte auf zweiten Spieler...', p.x + p.size / 2, p.y + p.size + 40);
                }
            }

        } else if (p.type === 'game' && p.gameType === 'pingpong') {
            // Render Ping Pong game
            const g = p;

            // Draw game background
            ctx.fillStyle = '#1a1a1a';
            ctx.fillRect(g.x, g.y, g.width, g.height);

            // Draw center line
            ctx.strokeStyle = '#444';
            ctx.lineWidth = 2;
            ctx.setLineDash([10, 5]);
            ctx.beginPath();
            ctx.moveTo(g.x + g.width / 2, g.y);
            ctx.lineTo(g.x + g.width / 2, g.y + g.height);
            ctx.stroke();
            ctx.setLineDash([]);

            // Draw paddles
            ctx.fillStyle = '#3498db'; // Blue for left
            ctx.fillRect(g.x + g.paddleLeft.x, g.y + g.paddleLeft.y, g.paddleLeft.width, g.paddleLeft.height);

            ctx.fillStyle = '#e74c3c'; // Red for right
            ctx.fillRect(g.x + g.paddleRight.x, g.y + g.paddleRight.y, g.paddleRight.width, g.paddleRight.height);

            // Draw ball
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.arc(g.x + g.ball.x, g.y + g.ball.y, g.ball.radius, 0, Math.PI * 2);
            ctx.fill();

            // Draw scores
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 48px -apple-system, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(g.paddleLeft.score, g.x + g.width / 4, g.y + 30);
            ctx.fillText(g.paddleRight.score, g.x + (g.width * 3) / 4, g.y + 30);

            // Draw status text
            ctx.font = 'bold 20px -apple-system, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';

            if (g.winner) {
                const isYouWinner = (g.winner === 'left' && socket.id === g.playerLeft) ||
                                   (g.winner === 'right' && socket.id === g.playerRight);
                const winnerText = isYouWinner ? 'Du gewinnst! 🏆' : 
                                  (g.winner === 'left' ? 'Blau gewinnt! 🏆' : 'Rot gewinnt! 🏆');
                ctx.fillStyle = '#27ae60';
                ctx.fillText(winnerText, g.x + g.width / 2, g.y + g.height + 10);
            } else if (!g.playerLeft || !g.playerRight) {
                ctx.fillStyle = '#999';
                ctx.font = '18px -apple-system, sans-serif';
                if (!g.playerLeft && !g.playerRight) {
                    ctx.fillText('👆 Klick auf einen Paddle zum Beitreten!', g.x + g.width / 2, g.y + g.height + 10);
                } else if (!g.playerRight) {
                    ctx.fillText('Warte auf Spieler 2 - Klick rechten Paddle!', g.x + g.width / 2, g.y + g.height + 10);
                } else if (!g.playerLeft) {
                    ctx.fillText('Warte auf Spieler 1 - Klick linken Paddle!', g.x + g.width / 2, g.y + g.height + 10);
                }
            } else {
                ctx.fillStyle = '#999';
                ctx.font = '16px -apple-system, sans-serif';
                const youAreLeft = socket.id === g.playerLeft;
                const youAreRight = socket.id === g.playerRight;

                if (youAreLeft) {
                    ctx.fillText('Du bist Blau (Links) - Ziehe deinen Paddle! 👆', g.x + g.width / 2, g.y + g.height + 10);
                } else if (youAreRight) {
                    ctx.fillText('Du bist Rot (Rechts) - Ziehe deinen Paddle! 👆', g.x + g.width / 2, g.y + g.height + 10);
                }
            }

        } else if (p.type === 'shape') {
            // Render recognized shapes
            ctx.lineWidth = p.brushSize || 3;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            ctx.beginPath();

            if (p.shapeType === 'line') {
                ctx.moveTo(p.points[0].x, p.points[0].y);
                ctx.lineTo(p.points[1].x, p.points[1].y);
            } else if (p.shapeType === 'circle') {
                ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
            } else if (p.shapeType === 'ellipse') {
                ctx.ellipse(p.x, p.y, p.radiusX, p.radiusY, 0, 0, Math.PI * 2);
            } else if (p.shapeType === 'rectangle' || p.shapeType === 'square') {
                ctx.rect(p.x, p.y, p.width, p.height);
            } else if (p.shapeType === 'triangle' && p.points.length >= 3) {
                ctx.moveTo(p.points[0].x, p.points[0].y);
                ctx.lineTo(p.points[1].x, p.points[1].y);
                ctx.lineTo(p.points[2].x, p.points[2].y);
                ctx.closePath();
            }

            ctx.stroke();
        } else if (p.type === 'line') {
            // Set opacity based on tool type
            if (p.tool === 'highlighter') {
                ctx.globalAlpha = 0.4;
            } else if (p.tool === 'marker') {
                ctx.globalAlpha = p.opacity || 0.3;
            } else {
                ctx.globalAlpha = 1.0;
            }

            ctx.beginPath();
            ctx.lineWidth = p.brushSize || 3;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            if (p.points.length > 0) {
                if (p.points.length < 3) {
                    // Too few points for smoothing, draw straight line
                    ctx.moveTo(p.points[0].x, p.points[0].y);
                    p.points.forEach(pt => ctx.lineTo(pt.x, pt.y));
                } else {
                    // Smooth curve using quadratic curves
                    ctx.moveTo(p.points[0].x, p.points[0].y);

                    for (let i = 1; i < p.points.length - 1; i++) {
                        const xc = (p.points[i].x + p.points[i + 1].x) / 2;
                        const yc = (p.points[i].y + p.points[i + 1].y) / 2;
                        ctx.quadraticCurveTo(p.points[i].x, p.points[i].y, xc, yc);
                    }

                    // Draw last segment
                    const lastPoint = p.points[p.points.length - 1];
                    const secondLastPoint = p.points[p.points.length - 2];
                    ctx.quadraticCurveTo(
                        secondLastPoint.x,
                        secondLastPoint.y,
                        lastPoint.x,
                        lastPoint.y
                    );
                }
                ctx.stroke();
            }
            ctx.globalAlpha = 1.0;
        } else if (p.type === 'text') {
            ctx.font = `${p.textSize || 18}px -apple-system, sans-serif`;
            ctx.textBaseline = "top";
            p.content.split('\n').forEach((line, i) => ctx.fillText(line, p.x, p.y + (i * (p.textSize || 18) * 1.3)));
        } else if (p.type === 'image') {
            if (!p._imgElement) {
                p._imgElement = new Image();
                p._imgElement.src = p.data;
                p._imgElement.onload = () => render();
            }
            if (p._imgElement.complete) {
                ctx.drawImage(p._imgElement, p.x, p.y, p.width, p.height);

                // Highlight selected image with resize handles
                if (selectedImage === index) {
                    ctx.strokeStyle = '#0095f6';
                    ctx.lineWidth = 3 / scale;
                    ctx.strokeRect(p.x - 5, p.y - 5, p.width + 10, p.height + 10);

                    // Draw resize handles
                    const handleSize = 12 / scale;
                    ctx.fillStyle = '#0095f6';
                    ctx.strokeStyle = 'white';
                    ctx.lineWidth = 2 / scale;

                    // Four corner handles
                    const handles = [
                        { x: p.x - 5, y: p.y - 5 }, // nw
                        { x: p.x + p.width + 5, y: p.y - 5 }, // ne
                        { x: p.x - 5, y: p.y + p.height + 5 }, // sw
                        { x: p.x + p.width + 5, y: p.y + p.height + 5 } // se
                    ];

                    handles.forEach(h => {
                        ctx.beginPath();
                        ctx.arc(h.x, h.y, handleSize, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.stroke();
                    });
                }
            }
        }
    });

    // Render laser paths with fade effect
    const now = Date.now();
    laserPaths = laserPaths.filter(laser => {
        const age = now - laser.timestamp;
        if (age > 2000) return false; // Remove after 2 seconds

        const fadeProgress = age / 2000;
        const alpha = 1 - fadeProgress;

        ctx.globalAlpha = alpha;
        ctx.strokeStyle = '#ff0000';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.shadowColor = '#ff0000';
        ctx.shadowBlur = 10 * alpha;

        ctx.beginPath();
        if (laser.points.length > 0) {
            ctx.moveTo(laser.points[0].x, laser.points[0].y);
            laser.points.forEach(pt => ctx.lineTo(pt.x, pt.y));
            ctx.stroke();
        }

        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1.0;
        return true;
    });

    // Continue animation if there are laser paths
    if (laserPaths.length > 0) {
        requestAnimationFrame(render);
    }

    // Draw current path with live preview
    if (currentPath && currentPath.points.length > 0) {
        // Use actual tool color for preview (except for laser which is always red)
        if (currentTool === 'laser') {
            ctx.strokeStyle = '#ff0000';
            ctx.globalAlpha = 0.8;
        } else if (currentTool === 'marker') {
            ctx.strokeStyle = currentPath.color || colorPicker.value;
            ctx.globalAlpha = currentPath.opacity || markerOpacity;
        } else if (currentTool === 'highlighter') {
            ctx.strokeStyle = currentPath.color || colorPicker.value;
            ctx.globalAlpha = 0.4;
        } else {
            ctx.strokeStyle = currentPath.color || colorPicker.value;
            ctx.globalAlpha = 1.0;
        }

        ctx.lineWidth = currentPath.brushSize || brushSize;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(currentPath.points[0].x, currentPath.points[0].y);
        currentPath.points.forEach(pt => ctx.lineTo(pt.x, pt.y));
        ctx.stroke();
        ctx.globalAlpha = 1.0;
    }

    // Draw "drawing cursor" for animating paths
    paths.forEach((p, index) => {
        if (p._isAnimating && p.points.length > 0) {
            const lastPoint = p.points[p.points.length - 1];

            // Draw pulsing circle at drawing position
            const pulseSize = 8 + Math.sin(Date.now() / 100) * 3;

            ctx.fillStyle = p.color || '#0095f6';
            ctx.globalAlpha = 0.6;
            ctx.beginPath();
            ctx.arc(lastPoint.x, lastPoint.y, pulseSize / scale, 0, Math.PI * 2);
            ctx.fill();

            // Outer ring
            ctx.strokeStyle = p.color || '#0095f6';
            ctx.lineWidth = 2 / scale;
            ctx.globalAlpha = 0.3;
            ctx.beginPath();
            ctx.arc(lastPoint.x, lastPoint.y, (pulseSize + 4) / scale, 0, Math.PI * 2);
            ctx.stroke();

            ctx.globalAlpha = 1.0;
        }
    });

    // Continue animation loop if paths are animating
    if (currentlyAnimating.length > 0) {
        requestAnimationFrame(render);
    }

    ctx.restore();
}

// ========== COORDINATE TRANSFORMATION ==========
function getModelPos(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: (clientX - rect.left - offset.x) / scale,
        y: (clientY - rect.top - offset.y) / scale
    };
}

function getScreenPos(modelX, modelY) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: modelX * scale + offset.x + rect.left,
        y: modelY * scale + offset.y + rect.top
    };
}

// ========== IMAGE DETECTION ==========
function getImageAtPos(pos) {
    for (let i = paths.length - 1; i >= 0; i--) {
        const p = paths[i];
        if (p.type === 'image' &&
            pos.x >= p.x && pos.x <= p.x + p.width &&
            pos.y >= p.y && pos.y <= p.y + p.height) {
            return i;
        }
    }
    return -1;
}

// ========== RESIZE HANDLE DETECTION ==========
function checkResizeHandles(clientX, clientY) {
    if (selectedImage === null) return null;

    const img = paths[selectedImage];
    const handleRadius = 20 / scale;

    const handles = {
        nw: getScreenPos(img.x - 5, img.y - 5),
        ne: getScreenPos(img.x + img.width + 5, img.y - 5),
        sw: getScreenPos(img.x - 5, img.y + img.height + 5),
        se: getScreenPos(img.x + img.width + 5, img.y + img.height + 5)
    };

    for (let [name, pos] of Object.entries(handles)) {
        const dist = Math.hypot(clientX - pos.x, clientY - pos.y);
        if (dist < handleRadius) {
            return name;
        }
    }

    return null;
}

// ========== ERASER CURSOR ==========
function showEraserCursor(clientX, clientY) {
    if (!eraserCursor) {
        eraserCursor = document.createElement('div');
        eraserCursor.style.position = 'fixed';
        eraserCursor.style.width = '30px';
        eraserCursor.style.height = '30px';
        eraserCursor.style.borderRadius = '50%';
        eraserCursor.style.border = '2px solid #0095f6';
        eraserCursor.style.pointerEvents = 'none';
        eraserCursor.style.zIndex = '9999';
        eraserCursor.style.transform = 'translate(-50%, -50%)';
        document.body.appendChild(eraserCursor);
    }
    eraserCursor.style.left = clientX + 'px';
    eraserCursor.style.top = clientY + 'px';
    eraserCursor.style.display = 'block';
}

function hideEraserCursor() {
    if (eraserCursor) {
        eraserCursor.style.display = 'none';
    }
}

// ========== TOUCH/MOUSE HANDLING ==========
container.addEventListener('pointerdown', handlePointerDown);
container.addEventListener('pointermove', handlePointerMove);
container.addEventListener('pointerup', handlePointerUp);
container.addEventListener('pointercancel', handlePointerUp);

function handlePointerDown(e) {
    // Ignore clicks on toolbar
    if (e.target.closest('#toolbar')) {
        return;
    }

    const pos = getModelPos(e.clientX, e.clientY);

    // Handle game placement
    if (pendingGame) {
        console.log('🎮 Placing game:', pendingGame, 'at', pos);
        placeGame(pendingGame, pos);
        pendingGame = null;
        canvas.style.cursor = 'crosshair';
        return;
    }

    // Handle game interaction
    if (handleGameClick(pos)) {
        return; // Game handled the click
    }

    // IMPROVED Apple Pencil detection
    // Apple Pencil has very small touch radius (typically 1-5px)
    // Finger has large touch radius (typically 20-60px)
    const touchSize = Math.max(e.width || 0, e.height || 0);
    isApplePencil = e.pointerType === 'pen' ||
                    (e.pointerType === 'touch' && touchSize < 15);

    console.log('🖊️ Pointer:', e.pointerType, 'Size:', touchSize, 'Apple Pencil:', isApplePencil);

    if (e.pointerType === 'touch') {
        touches.push(e);
        if (touches.length >= 2) {
            // Two-finger pan
            isPanning = true;
            currentPath = null;
            selectedImage = null;
            render();
            return;
        }
    }

    touchStartTime = Date.now();
    touchStartPos = { x: e.clientX, y: e.clientY };

    // Check for resize handle interaction - always allow resizing regardless of input type
    if (selectedImage !== null) {
        const handle = checkResizeHandles(e.clientX, e.clientY);
        if (handle) {
            console.log('🎯 Starting resize on handle:', handle);
            isResizingImage = true;
            resizeHandle = handle;
            const img = paths[selectedImage];
            imageStartPos = { x: img.x, y: img.y };
            imageStartSize = { width: img.width, height: img.height };
            dragStartPos = { x: e.clientX, y: e.clientY };
            return;
        }
    }

    // Check for image interaction - ONLY when NOT in drawing tool mode OR with finger (not pencil)
    const imageIndex = getImageAtPos(pos);
    const isDrawingTool = (currentTool === 'pen' || currentTool === 'highlighter' || currentTool === 'laser' || currentTool === 'marker');

    // Images can only be moved with finger (not Apple Pencil) or in non-drawing tools
    const canMoveImage = !isDrawingTool || !isApplePencil;

    if (imageIndex !== -1 && canMoveImage) {
        console.log('🖼️ Image selected at index:', imageIndex);
        // Double tap detection
        const currentTime = Date.now();
        if (currentTime - lastTapTime < 300 && selectedImage === imageIndex) {
            // Double tap - deselect
            console.log('👆 Double tap - deselecting');
            selectedImage = null;
            render();
            lastTapTime = 0;
            return;
        }
        lastTapTime = currentTime;

        // Select image
        selectedImage = imageIndex;
        isDraggingImage = true;
        dragStartPos = { x: e.clientX, y: e.clientY };
        const img = paths[imageIndex];
        imageStartPos = { x: img.x, y: img.y };
        console.log('📍 Starting drag from position:', imageStartPos);
        render();
        return;
    }

    // Deselect image if clicking elsewhere (but not when drawing)
    if (selectedImage !== null && !isDrawingTool) {
        console.log('❌ Deselecting image');
        selectedImage = null;
        render();
    }

    // WICHTIG: Nur Apple Pencil kann zeichnen, Finger kann nur bewegen/pannen
    const canDraw = isApplePencil || e.pointerType === 'mouse';

    // Tool actions - only if allowed to draw
    if (currentTool === 'eraser' && canDraw) {
        isErasing = true;
        deleteObjectAt(pos);
    } else if (currentTool === 'text' && canDraw) {
        openTextEditor(e.clientX, e.clientY);
    } else if (currentTool === 'laser' && canDraw) {
        // Start laser pointer path
        currentPath = {
            type: 'laser',
            points: [pos],
            timestamp: Date.now()
        };
        laserPaths.push(currentPath);
    } else if (currentTool === 'shape' && canDraw) {
        // Shape recognition tool - draw freehand first, then recognize
        currentPath = {
            type: 'line',
            color: colorPicker.value,
            points: [pos],
            brushSize: brushSize,
            tool: 'shape',
            _isShapeDrawing: true
        };
        paths.push(currentPath);
    } else if ((currentTool === 'pen' || currentTool === 'highlighter' || currentTool === 'marker') && canDraw) {
        // Use thicker brush for marker tool by default
        const toolBrushSize = currentTool === 'marker' ? Math.max(brushSize, 8) : brushSize;

        currentPath = {
            type: 'line',
            color: colorPicker.value,
            points: [pos],
            brushSize: toolBrushSize,
            tool: currentTool,
            opacity: currentTool === 'marker' ? markerOpacity : undefined
        };
        paths.push(currentPath);
    } else if (!canDraw) {
        console.log('👆 Finger detected - only panning/moving allowed');
    }
}

function handlePointerMove(e) {
    if (e.pointerType === 'touch') {
        const idx = touches.findIndex(t => t.pointerId === e.pointerId);
        if (idx !== -1) touches[idx] = e;

        if (touches.length >= 2) {
            // Two-finger pan
            offset.x += e.movementX;
            offset.y += e.movementY;
            render();
            return;
        }
    }

    const pos = getModelPos(e.clientX, e.clientY);

    // Handle paddle dragging
    if (isDraggingPaddle && draggedPaddleGame !== null) {
        const game = paths[draggedPaddleGame];
        if (game && game.type === 'game' && game.gameType === 'pingpong') {
            // Calculate new paddle Y position (relative to game area)
            const relativeY = pos.y - game.y;
            
            if (draggedPaddleSide === 'left' && socket.id === game.playerLeft) {
                // Update left paddle
                game.paddleLeft.y = Math.max(0, Math.min(game.height - game.paddleLeft.height, relativeY - game.paddleLeft.height / 2));
                console.log('🏓 Moving left paddle to Y:', game.paddleLeft.y.toFixed(1));
            } else if (draggedPaddleSide === 'right' && socket.id === game.playerRight) {
                // Update right paddle
                game.paddleRight.y = Math.max(0, Math.min(game.height - game.paddleRight.height, relativeY - game.paddleRight.height / 2));
                console.log('🏓 Moving right paddle to Y:', game.paddleRight.y.toFixed(1));
            }
            
            render();
            throttledPaddleSync();
        }
        return;
    }

    if (isResizingImage && selectedImage !== null) {
        const img = paths[selectedImage];
        const deltaX = (e.clientX - dragStartPos.x) / scale;
        const deltaY = (e.clientY - dragStartPos.y) / scale;

        if (resizeHandle === 'se') {
            img.width = Math.max(50, imageStartSize.width + deltaX);
            img.height = Math.max(50, imageStartSize.height + deltaY);
        } else if (resizeHandle === 'sw') {
            const newWidth = Math.max(50, imageStartSize.width - deltaX);
            img.x = imageStartPos.x + (imageStartSize.width - newWidth);
            img.width = newWidth;
            img.height = Math.max(50, imageStartSize.height + deltaY);
        } else if (resizeHandle === 'ne') {
            img.width = Math.max(50, imageStartSize.width + deltaX);
            const newHeight = Math.max(50, imageStartSize.height - deltaY);
            img.y = imageStartPos.y + (imageStartSize.height - newHeight);
            img.height = newHeight;
        } else if (resizeHandle === 'nw') {
            const newWidth = Math.max(50, imageStartSize.width - deltaX);
            const newHeight = Math.max(50, imageStartSize.height - deltaY);
            img.x = imageStartPos.x + (imageStartSize.width - newWidth);
            img.y = imageStartPos.y + (imageStartSize.height - newHeight);
            img.width = newWidth;
            img.height = newHeight;
        }
        console.log('📏 Resizing to:', img.width, 'x', img.height);
        render();
        throttledSync();
    } else if (isDraggingImage && selectedImage !== null) {
        const deltaX = (e.clientX - dragStartPos.x) / scale;
        const deltaY = (e.clientY - dragStartPos.y) / scale;
        const newX = imageStartPos.x + deltaX;
        const newY = imageStartPos.y + deltaY;
        paths[selectedImage].x = newX;
        paths[selectedImage].y = newY;
        console.log('🚚 Dragging to:', newX.toFixed(1), ',', newY.toFixed(1));
        render();
        throttledSync();
    } else if (currentPath) {
        currentPath.points.push(pos);

        // For laser pointer, trigger continuous render
        if (currentTool === 'laser') {
            render();
        } else {
            render();
        }
    } else if (isErasing) {
        deleteObjectAt(pos);
    } else if (isPanning) {
        offset.x += e.movementX;
        offset.y += e.movementY;
        render();
    }

    // Update cursor for eraser
    if (currentTool === 'eraser' && !isPanning) {
        showEraserCursor(e.clientX, e.clientY);
    }
}

function handlePointerUp(e) {
    if (e.pointerType === 'touch') {
        touches = touches.filter(t => t.pointerId !== e.pointerId);
    }

    const duration = Date.now() - touchStartTime;
    const moved = Math.hypot(
        e.clientX - touchStartPos.x,
        e.clientY - touchStartPos.y
    );

    console.log('⬆️ Pointer up - moved:', moved.toFixed(1), 'px, duration:', duration, 'ms');
    console.log('   isDragging:', isDraggingImage, 'isResizing:', isResizingImage, 'selectedImage:', selectedImage);

    // Check for long press to delete image
    if (selectedImage !== null && !isDraggingImage && !isResizingImage && moved < 10) {
        if (duration > 500) {
            console.log('🗑️ Long press detected - deleting image');
            if (confirm('Bild löschen?')) {
                paths.splice(selectedImage, 1);
                selectedImage = null;
                render();
                syncToServer();
            }
            currentPath = null;
            isPanning = false;
            isDraggingImage = false;
            isResizingImage = false;
            isErasing = false;
            hideEraserCursor();
            return;
        }
    }

    if (currentPath) {
        if (currentTool === 'laser') {
            // Laser pointer - send to server for real-time sync
            console.log('🔴 Laser pointer drawn, broadcasting to others');

            // Send laser path to other users
            socket.emit('laser_pointer', {
                room: currentRoom,
                laser: {
                    points: currentPath.points,
                    timestamp: Date.now()
                }
            });

            render(); // Trigger fade animation
        } else if (currentTool === 'shape' && currentPath._isShapeDrawing) {
            // Shape recognition - analyze the drawn path
            console.log('🔍 Analyzing shape with', currentPath.points.length, 'points');
            const recognizedShape = recognizeShape(currentPath);

            if (recognizedShape) {
                // Replace freehand with recognized shape
                const index = paths.indexOf(currentPath);
                if (index !== -1) {
                    paths[index] = recognizedShape;
                }
                console.log('✨ Shape recognized:', recognizedShape.shapeType);
            }

            // Send final shape to server
            const finalPath = paths[paths.indexOf(currentPath)] || currentPath;
            socket.emit('new_element', { room: currentRoom, element: finalPath });
        } else {
            console.log('✏️ Sending drawing with', currentPath.points.length, 'points');

            // Finalize with actual color
            const finalPath = {
                ...currentPath,
                color: colorPicker.value
            };

            // Replace current path in array
            const index = paths.indexOf(currentPath);
            if (index !== -1) {
                paths[index] = finalPath;
            }

            socket.emit('new_element', { room: currentRoom, element: finalPath });
        }
    }

    // Sync after dragging or resizing image
    if ((isDraggingImage || isResizingImage) && selectedImage !== null && moved > 5) {
        const img = paths[selectedImage];
        console.log('💾 Final sync after drag/resize');
        isLocalUpdate = true;
        socket.emit('full_sync', { room: currentRoom, data: paths });
        setTimeout(() => {
            isLocalUpdate = false;
            console.log('🔓 Local update flag cleared');
        }, 500);
    }

    // Sync after dragging paddle
    if (isDraggingPaddle && draggedPaddleGame !== null) {
        console.log('💾 Final paddle sync');
        const game = paths[draggedPaddleGame];
        if (game) {
            socket.emit('game_move', { room: currentRoom, gameIndex: draggedPaddleGame, game: game });
        }
    }

    currentPath = null;
    isPanning = false;
    isDraggingImage = false;
    isResizingImage = false;
    isErasing = false;
    isApplePencil = false; // Reset Apple Pencil detection
    isDraggingPaddle = false; // Reset paddle dragging
    draggedPaddleGame = null;
    draggedPaddleSide = null;
    hideEraserCursor();
    render();

    console.log('🏁 Pointer up complete - state reset');
}

// ========== SYNC HELPER ==========
let syncTimeout = null;

function throttledSync() {
    if (syncTimeout) return;
    syncTimeout = setTimeout(() => {
        console.log('⚡ Real-time throttled sync');
        const cleanPaths = cleanPathsForSync();
        socket.emit('full_sync', { room: currentRoom, data: cleanPaths });
        syncTimeout = null;
    }, 100);
}

let paddleSyncTimeout = null;
function throttledPaddleSync() {
    if (paddleSyncTimeout) return;
    paddleSyncTimeout = setTimeout(() => {
        if (draggedPaddleGame !== null) {
            const game = paths[draggedPaddleGame];
            if (game) {
                socket.emit('game_move', { room: currentRoom, gameIndex: draggedPaddleGame, game: game });
            }
        }
        paddleSyncTimeout = null;
    }, 50); // Faster sync for smoother gameplay
}

function syncToServer() {
    console.log('📡 Broadcasting full sync');
    const cleanPaths = cleanPathsForSync();
    socket.emit('full_sync', { room: currentRoom, data: cleanPaths });
}

function cleanPathsForSync() {
    return paths.map(p => {
        const cleaned = { ...p };
        delete cleaned._imgElement;
        return cleaned;
    });
}

// ========== PINCH ZOOM ==========
let lastPinchDistance = 0;

container.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        lastPinchDistance = Math.hypot(dx, dy);
    }
});

container.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const distance = Math.hypot(dx, dy);
        const delta = distance / lastPinchDistance;

        const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const centerY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const rect = canvas.getBoundingClientRect();
        const mouseX = centerX - rect.left;
        const mouseY = centerY - rect.top;

        const worldX = (mouseX - offset.x) / scale;
        const worldY = (mouseY - offset.y) / scale;

        scale = Math.max(0.5, Math.min(3, scale * delta));

        offset.x = mouseX - worldX * scale;
        offset.y = mouseY - worldY * scale;

        lastPinchDistance = distance;
        render();
    }
}, { passive: false });

// ========== MOUSE WHEEL ZOOM ==========
container.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const worldX = (mouseX - offset.x) / scale;
    const worldY = (mouseY - offset.y) / scale;

    scale = Math.max(0.5, Math.min(3, scale * delta));

    offset.x = mouseX - worldX * scale;
    offset.y = mouseY - worldY * scale;

    render();
}, { passive: false });

// ========== GAMES SYSTEM ==========
function placeGame(gameType, pos) {
    if (gameType === 'tictactoe') {
        const game = {
            type: 'game',
            gameType: 'tictactoe',
            x: pos.x,
            y: pos.y,
            size: 300,
            board: Array(9).fill(null), // 3x3 grid
            currentPlayer: 'X',
            winner: null,
            winLine: null,
            playerX: null,
            playerO: null
        };

        const gameIndex = paths.length;
        paths.push(game);

        console.log('✅ Tic Tac Toe placed at index', gameIndex, 'position:', pos);
        console.log('📤 Sending new game to server');

        socket.emit('new_element', { room: currentRoom, element: game });
        render();
    } else if (gameType === 'pingpong') {
        const game = {
            type: 'game',
            gameType: 'pingpong',
            x: pos.x,
            y: pos.y,
            width: 600,
            height: 400,
            ball: { x: 300, y: 200, dx: 4, dy: 3, radius: 8 },
            paddleLeft: { x: 20, y: 170, width: 12, height: 60, score: 0 },
            paddleRight: { x: 568, y: 170, width: 12, height: 60, score: 0 },
            playerLeft: null,
            playerRight: null,
            gameStarted: false,
            paused: false,
            winner: null,
            lastUpdate: Date.now()
        };

        const gameIndex = paths.length;
        paths.push(game);

        console.log('✅ Ping Pong placed at index', gameIndex, 'position:', pos);
        console.log('📤 Sending new game to server');

        socket.emit('new_element', { room: currentRoom, element: game });
        render();
        
        // Start game loop for this game
        startPingPongLoop(gameIndex);
    }
}

function handleGameClick(pos) {
    // Check if clicking on any game
    for (let i = 0; i < paths.length; i++) {
        const game = paths[i];
        if (game.type === 'game' && game.gameType === 'tictactoe') {
            // Check if click is within game bounds
            if (pos.x >= game.x && pos.x <= game.x + game.size &&
                pos.y >= game.y && pos.y <= game.y + game.size) {

                // Don't play if game is over
                if (game.winner) {
                    console.log('⚠️ Game already over');
                    return true;
                }

                // Assign players if not assigned yet
                if (!game.playerX) {
                    game.playerX = socket.id;
                    console.log('👤 Player X:', socket.id);
                }

                // Second player becomes O
                if (!game.playerO && socket.id !== game.playerX) {
                    game.playerO = socket.id;
                    console.log('👤 Player O:', socket.id);
                }

                // Check if it's this player's turn
                const isPlayerX = socket.id === game.playerX;
                const isPlayerO = socket.id === game.playerO;

                if ((game.currentPlayer === 'X' && !isPlayerX) ||
                    (game.currentPlayer === 'O' && !isPlayerO)) {
                    console.log('⏸️ Not your turn! Current player:', game.currentPlayer);
                    return true; // Consumed click but didn't make move
                }

                // Calculate which cell was clicked
                const cellSize = game.size / 3;
                const col = Math.floor((pos.x - game.x) / cellSize);
                const row = Math.floor((pos.y - game.y) / cellSize);
                const cellIndex = row * 3 + col;

                // Make move if cell is empty
                if (game.board[cellIndex] === null) {
                    game.board[cellIndex] = game.currentPlayer;
                    console.log(`🎮 ${game.currentPlayer} played at cell ${cellIndex}`);

                    // Check for winner
                    const winResult = checkTicTacToeWinner(game.board);
                    if (winResult) {
                        game.winner = winResult.winner;
                        game.winLine = winResult.line;
                        console.log('🏆 Winner:', game.winner);
                    } else {
                        // Switch player
                        game.currentPlayer = game.currentPlayer === 'X' ? 'O' : 'X';
                    }

                    // Sync to server
                    console.log('📤 Sending game move to server:', {
                        room: currentRoom,
                        gameIndex: i,
                        player: game.currentPlayer === 'X' ? 'O' : 'X', // Previous player (who just moved)
                        cellIndex: cellIndex
                    });
                    socket.emit('game_move', { room: currentRoom, gameIndex: i, game: game });
                    render();
                    return true;
                } else {
                    console.log('⚠️ Cell already occupied');
                }
            }
        } else if (game.type === 'game' && game.gameType === 'pingpong') {
            // Check if click is within game bounds
            if (pos.x >= game.x && pos.x <= game.x + game.width &&
                pos.y >= game.y && pos.y <= game.y + game.height) {

                // Don't interact if game is over
                if (game.winner) {
                    console.log('⚠️ Game already over');
                    return true;
                }

                // Check if clicking on left paddle
                const leftPaddleX = game.x + game.paddleLeft.x;
                const leftPaddleY = game.y + game.paddleLeft.y;
                if (pos.x >= leftPaddleX - 20 && pos.x <= leftPaddleX + game.paddleLeft.width + 20 &&
                    pos.y >= leftPaddleY - 20 && pos.y <= leftPaddleY + game.paddleLeft.height + 20) {
                    
                    // Assign player if not assigned
                    if (!game.playerLeft) {
                        game.playerLeft = socket.id;
                        console.log('👤 Player Left (Blue) assigned:', socket.id);
                        socket.emit('game_move', { room: currentRoom, gameIndex: i, game: game });
                    }
                    
                    // Start dragging if this is our paddle
                    if (socket.id === game.playerLeft) {
                        isDraggingPaddle = true;
                        draggedPaddleGame = i;
                        draggedPaddleSide = 'left';
                        console.log('🏓 Started dragging left paddle');
                    }
                    
                    // Start game if both players are ready
                    if (!game.gameStarted && game.playerLeft && game.playerRight) {
                        game.gameStarted = true;
                        startPingPongLoop(i);
                        socket.emit('game_move', { room: currentRoom, gameIndex: i, game: game });
                    }
                    
                    render();
                    return true;
                }

                // Check if clicking on right paddle
                const rightPaddleX = game.x + game.paddleRight.x;
                const rightPaddleY = game.y + game.paddleRight.y;
                if (pos.x >= rightPaddleX - 20 && pos.x <= rightPaddleX + game.paddleRight.width + 20 &&
                    pos.y >= rightPaddleY - 20 && pos.y <= rightPaddleY + game.paddleRight.height + 20) {
                    
                    // Assign player if not assigned and different from left player
                    if (!game.playerRight && socket.id !== game.playerLeft) {
                        game.playerRight = socket.id;
                        console.log('👤 Player Right (Red) assigned:', socket.id);
                        socket.emit('game_move', { room: currentRoom, gameIndex: i, game: game });
                    }
                    
                    // Start dragging if this is our paddle
                    if (socket.id === game.playerRight) {
                        isDraggingPaddle = true;
                        draggedPaddleGame = i;
                        draggedPaddleSide = 'right';
                        console.log('🏓 Started dragging right paddle');
                    }
                    
                    // Start game if both players are ready
                    if (!game.gameStarted && game.playerLeft && game.playerRight) {
                        game.gameStarted = true;
                        startPingPongLoop(i);
                        socket.emit('game_move', { room: currentRoom, gameIndex: i, game: game });
                    }
                    
                    render();
                    return true;
                }

                // If clicking anywhere else in the game area, show instructions
                return true;
            }
        }
    }
    return false;
}

function checkTicTacToeWinner(board) {
    const lines = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8], // Rows
        [0, 3, 6], [1, 4, 7], [2, 5, 8], // Columns
        [0, 4, 8], [2, 4, 6]              // Diagonals
    ];

    for (let line of lines) {
        const [a, b, c] = line;
        if (board[a] && board[a] === board[b] && board[a] === board[c]) {
            return { winner: board[a], line: line };
        }
    }

    // Check for draw
    if (board.every(cell => cell !== null)) {
        return { winner: 'Draw', line: null };
    }

    return null;
}

// ========== TOOL SELECTION ==========
function setTool(t) {
    currentTool = t;
    selectedImage = null;
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(t + 'Btn');
    if (btn) btn.classList.add('active');

    if (t === 'eraser') {
        canvas.style.cursor = 'none';
    } else if (t === 'text') {
        canvas.style.cursor = 'text';
    } else if (t === 'laser') {
        canvas.style.cursor = 'crosshair';
    } else if (t === 'marker') {
        canvas.style.cursor = 'crosshair';
        // Auto-suggest thicker brush for marker
        if (brushSize < 8) {
            console.log('💡 Tipp: Marker funktionieren besser mit dickeren Pinselgrößen (aktuell: ' + brushSize + 'px)');
        }
    } else {
        canvas.style.cursor = 'crosshair';
    }

    hideEraserCursor();
    render();
}

container.addEventListener('mousemove', (e) => {
    if (currentTool === 'eraser' && !isPanning && !isDraggingImage) {
        showEraserCursor(e.clientX, e.clientY);
    }
});

// ========== CHAT FUNCTIONS ==========
function toggleChat() {
    const sidebar = document.getElementById('chat-sidebar');
    sidebar.classList.toggle('closed');
    if (!sidebar.classList.contains('closed')) {
        unreadCount = 0;
        updateBadge();
    }
    setTimeout(init, 350);
}

function sendChatMessage() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chat_message', { room: currentRoom, text: text });
    addMessageToUI('Ich', text, 'msg-me');
    input.value = '';
}

function addMessageToUI(sender, text, className) {
    const div = document.createElement('div');
    div.className = `chat-msg ${className}`;
    div.innerText = text;
    const msgContainer = document.getElementById('chat-messages');
    msgContainer.appendChild(div);
    msgContainer.scrollTop = msgContainer.scrollHeight;
}

function updateBadge() {
    const badge = document.getElementById('unread-badge');
    badge.innerText = unreadCount;
    badge.style.display = unreadCount > 0 ? 'flex' : 'none';
}

// ========== PDF HANDLING ==========
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

document.getElementById('pdfInput').addEventListener('change', handlePDF);

async function handlePDF(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function() {
        const pdf = await pdfjsLib.getDocument(new Uint8Array(this.result)).promise;
        for(let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale: 2.0 });
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = viewport.width;
            tempCanvas.height = viewport.height;
            await page.render({
                canvasContext: tempCanvas.getContext('2d'),
                viewport
            }).promise;

            tempCanvas.toBlob(async (blob) => {
                const formData = new FormData();
                formData.append('file', blob, `pdf-page-${i}.png`);

                try {
                    const response = await fetch('/upload', {
                        method: 'POST',
                        body: formData
                    });
                    const result = await response.json();

                    if (result.success) {
                        const el = {
                            type: 'image',
                            data: result.url,
                            x: (container.clientWidth/2 - viewport.width/4) / scale - offset.x/scale,
                            y: (50 + (i-1) * (viewport.height/2 + 30)) / scale - offset.y/scale,
                            width: viewport.width / 2,
                            height: viewport.height / 2
                        };
                        paths.push(el);
                        socket.emit('new_element', { room: currentRoom, element: el });
                        render();
                    }
                } catch (error) {
                    console.error('Upload failed:', error);
                }
            }, 'image/png', 0.9);
        }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
}

// ========== IMAGE HANDLING ==========
document.getElementById('imageInput').addEventListener('change', handleImage);

async function handleImage(e) {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
        const response = await fetch('/upload', {
            method: 'POST',
            body: formData
        });
        const result = await response.json();

        if (result.success) {
            const img = new Image();
            img.onload = function() {
                const maxWidth = 600;
                const maxHeight = 600;
                let width = img.width;
                let height = img.height;

                if (width > maxWidth || height > maxHeight) {
                    const ratio = Math.min(maxWidth / width, maxHeight / height);
                    width *= ratio;
                    height *= ratio;
                }

                const el = {
                    type: 'image',
                    data: result.url,
                    x: (container.clientWidth/2 - width/2) / scale - offset.x/scale,
                    y: (container.clientHeight/2 - height/2) / scale - offset.y/scale,
                    width: width,
                    height: height
                };
                paths.push(el);
                socket.emit('new_element', { room: currentRoom, element: el });
                render();
            };
            img.src = result.url;
        }
    } catch (error) {
        console.error('Upload failed:', error);
        alert('Bild-Upload fehlgeschlagen');
    }

    e.target.value = '';
}

// ========== TEXT EDITOR ==========
function openTextEditor(clientX, clientY) {
    const toolbar = document.getElementById('toolbar');
    const toolbarRect = toolbar.getBoundingClientRect();

    if (clientX >= toolbarRect.left && clientX <= toolbarRect.right &&
        clientY >= toolbarRect.top && clientY <= toolbarRect.bottom) {
        console.log('Ignoring text editor on toolbar');
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.className = 'text-editor';
    textarea.style.left = clientX + 'px';
    textarea.style.top = clientY + 'px';
    textarea.style.fontSize = textSize + 'px';
    container.appendChild(textarea);
    textarea.focus();

    textarea.addEventListener('blur', () => {
        if (textarea.value.trim() !== "") {
            const worldPos = getModelPos(clientX, clientY);
            const el = {
                type: 'text',
                content: textarea.value,
                x: worldPos.x,
                y: worldPos.y,
                color: colorPicker.value,
                textSize: textSize
            };
            paths.push(el);
            socket.emit('new_element', { room: currentRoom, element: el });
        }
        textarea.remove();
        render();
    });
}

// ========== CLEAR ALL ==========
function clearAll() {
    if (!confirm("Alles löschen?")) return;
    paths = [];
    selectedImage = null;
    render();
    syncToServer();
}

// ========== DELETE OBJECT ==========
function deleteObjectAt(pos) {
    const threshold = 30 / scale;
    let changed = false;

    paths = paths.filter(p => {
        let hit = false;
        if (p.type === 'line') {
            hit = p.points.some(pt => Math.hypot(pt.x - pos.x, pt.y - pos.y) < threshold);
        } else if (p.type === 'shape') {
            // Check if clicking on a shape
            if (p.shapeType === 'line' && p.points && p.points.length >= 2) {
                // Check if near line
                hit = pointToLineDistance(pos, p.points[0], p.points[1]) < threshold;
            } else if (p.shapeType === 'circle') {
                // Check if on circle perimeter
                const distFromCenter = Math.hypot(pos.x - p.x, pos.y - p.y);
                hit = Math.abs(distFromCenter - p.radius) < threshold;
            } else if (p.shapeType === 'ellipse') {
                // Check if on ellipse perimeter (simplified)
                const dx = (pos.x - p.x) / p.radiusX;
                const dy = (pos.y - p.y) / p.radiusY;
                const distFromCenter = Math.sqrt(dx * dx + dy * dy);
                hit = Math.abs(distFromCenter - 1) < threshold / Math.min(p.radiusX, p.radiusY);
            } else if (p.shapeType === 'rectangle' || p.shapeType === 'square') {
                // Check if on rectangle perimeter or inside
                hit = (pos.x >= p.x - threshold && pos.x <= p.x + p.width + threshold &&
                       pos.y >= p.y - threshold && pos.y <= p.y + p.height + threshold);
            } else if (p.shapeType === 'triangle' && p.points && p.points.length >= 3) {
                // Check if on triangle edges or inside
                hit = isPointNearTriangle(pos, p.points, threshold);
            }
        } else if (p.type === 'game') {
            // Check if clicking on a game board
            if (p.gameType === 'tictactoe') {
                hit = (pos.x >= p.x && pos.x <= p.x + p.size &&
                       pos.y >= p.y && pos.y <= p.y + p.size);
            } else if (p.gameType === 'pingpong') {
                hit = (pos.x >= p.x && pos.x <= p.x + p.width &&
                       pos.y >= p.y && pos.y <= p.y + p.height);
            }
            if (hit) {
                console.log('🗑️ Deleting game at', p.x, p.y);
            }
        } else if (p.type === 'image') {
            hit = (pos.x >= p.x && pos.x <= p.x + p.width &&
                   pos.y >= p.y && pos.y <= p.y + p.height);
        } else if (p.type === 'text') {
            hit = (pos.x >= p.x && pos.x <= p.x + 150 &&
                   pos.y >= p.y && pos.y <= p.y + 30);
        }
        if (hit) changed = true;
        return !hit;
    });

    if (changed) {
        render();
        syncToServer();
    }
}

function isPointNearTriangle(point, trianglePoints, threshold) {
    // Check if point is near any edge of the triangle
    for (let i = 0; i < 3; i++) {
        const p1 = trianglePoints[i];
        const p2 = trianglePoints[(i + 1) % 3];
        if (pointToLineDistance(point, p1, p2) < threshold) {
            return true;
        }
    }

    // Also check if point is inside triangle (for easier deletion)
    const [p1, p2, p3] = trianglePoints;
    const d1 = sign(point, p1, p2);
    const d2 = sign(point, p2, p3);
    const d3 = sign(point, p3, p1);

    const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
    const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);

    return !(hasNeg && hasPos);
}

function sign(p1, p2, p3) {
    return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
}

// ========== PING PONG GAME LOGIC ==========
const pingPongLoops = {}; // Track active game loops

function startPingPongLoop(gameIndex) {
    // Prevent multiple loops for same game
    if (pingPongLoops[gameIndex]) {
        return;
    }

    console.log('🎮 Starting Ping Pong loop for game', gameIndex);

    pingPongLoops[gameIndex] = setInterval(() => {
        if (!paths[gameIndex] || paths[gameIndex].type !== 'game' || paths[gameIndex].gameType !== 'pingpong') {
            clearInterval(pingPongLoops[gameIndex]);
            delete pingPongLoops[gameIndex];
            return;
        }

        const game = paths[gameIndex];

        // Don't update if game is over or not started
        if (game.winner || !game.gameStarted || game.paused) {
            return;
        }

        // Check if both players are assigned
        if (!game.playerLeft || !game.playerRight) {
            return;
        }

        const now = Date.now();
        const deltaTime = (now - game.lastUpdate) / 16.67; // Normalize to 60fps
        game.lastUpdate = now;

        // Move ball (only one player controls physics to avoid desync)
        if (socket.id === game.playerLeft) {
            game.ball.x += game.ball.dx * deltaTime;
            game.ball.y += game.ball.dy * deltaTime;

            // Ball collision with top/bottom walls
            if (game.ball.y - game.ball.radius <= 0 || game.ball.y + game.ball.radius >= game.height) {
                game.ball.dy *= -1;
                game.ball.y = game.ball.y - game.ball.radius <= 0 ? game.ball.radius : game.height - game.ball.radius;
            }

            // Ball collision with left paddle
            if (game.ball.x - game.ball.radius <= game.paddleLeft.x + game.paddleLeft.width &&
                game.ball.x >= game.paddleLeft.x &&
                game.ball.y >= game.paddleLeft.y &&
                game.ball.y <= game.paddleLeft.y + game.paddleLeft.height) {
                
                game.ball.dx = Math.abs(game.ball.dx);
                game.ball.x = game.paddleLeft.x + game.paddleLeft.width + game.ball.radius;
                
                // Add spin based on where ball hits paddle
                const hitPos = (game.ball.y - game.paddleLeft.y) / game.paddleLeft.height;
                game.ball.dy = (hitPos - 0.5) * 8;
            }

            // Ball collision with right paddle
            if (game.ball.x + game.ball.radius >= game.paddleRight.x &&
                game.ball.x <= game.paddleRight.x + game.paddleRight.width &&
                game.ball.y >= game.paddleRight.y &&
                game.ball.y <= game.paddleRight.y + game.paddleRight.height) {
                
                game.ball.dx = -Math.abs(game.ball.dx);
                game.ball.x = game.paddleRight.x - game.ball.radius;
                
                // Add spin based on where ball hits paddle
                const hitPos = (game.ball.y - game.paddleRight.y) / game.paddleRight.height;
                game.ball.dy = (hitPos - 0.5) * 8;
            }

            // Scoring - ball goes off left side
            if (game.ball.x - game.ball.radius <= 0) {
                game.paddleRight.score++;
                resetBall(game);
                
                // Check for winner
                if (game.paddleRight.score >= 7) {
                    game.winner = 'right';
                    clearInterval(pingPongLoops[gameIndex]);
                    delete pingPongLoops[gameIndex];
                }
            }

            // Scoring - ball goes off right side
            if (game.ball.x + game.ball.radius >= game.width) {
                game.paddleLeft.score++;
                resetBall(game);
                
                // Check for winner
                if (game.paddleLeft.score >= 7) {
                    game.winner = 'left';
                    clearInterval(pingPongLoops[gameIndex]);
                    delete pingPongLoops[gameIndex];
                }
            }

            // Sync game state to other players
            socket.emit('game_move', { room: currentRoom, gameIndex: gameIndex, game: game });
        }

        render();
    }, 16); // ~60fps
}

function resetBall(game) {
    game.ball.x = game.width / 2;
    game.ball.y = game.height / 2;
    game.ball.dx = (Math.random() > 0.5 ? 1 : -1) * 4;
    game.ball.dy = (Math.random() - 0.5) * 4;
}

// ========== EVENT LISTENERS ==========
window.addEventListener('resize', () => {
    console.log('📱 Window resized, reinitializing canvas');
    setTimeout(init, 100); // Small delay to ensure correct dimensions
});

// Handle orientation changes on mobile
window.addEventListener('orientationchange', () => {
    console.log('🔄 Orientation changed, reinitializing canvas');
    setTimeout(init, 200);
});

document.getElementById('chatInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendChatMessage();
});

// ========== INITIALIZE ==========
// Wait for DOM to be fully loaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Also init after a short delay to ensure everything is rendered
setTimeout(init, 100);
