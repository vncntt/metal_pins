import {
  AutoModel,
  AutoImageProcessor,
  RawImage,
} from "@huggingface/transformers";
 
// Check if we can use GPU fp16
async function hasFp16() {
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter.features.has("shader-f16");
  } catch {
    return false;
  }
}
 
// Elements from the DOM
const statusEl = document.getElementById("status");
const canvas = document.createElement("canvas");
const outputCanvas = document.getElementById("output-canvas");
const video = document.getElementById("video");
const sizeSlider = document.getElementById("size");
const sizeLabel = document.getElementById("size-value");
 
// Setup for 3D pins
let scene, camera, renderer, controls;
let pins = [];
 
const gridSize = 120;
const spacing = 0.2;
const pinRadius = 0.12;
const pinHeight = 5.0;
const pinDepthScale = 10.0;  
// Add border size for the frame
const borderSize = 2; // Extra space on each side
 
// For hex grids, define horizontal/vertical spacing
const hexHorizontalSpacing = Math.sqrt(3) * spacing; // distance between pin centers in x
const hexVerticalSpacing = 1.5 * spacing;            // distance between pin centers in z
// We'll compute the bounding width/height for the hex grid
const totalWidth = (gridSize - 1) * hexHorizontalSpacing + spacing;
const totalHeight = (gridSize - 1) * hexVerticalSpacing + spacing;
// Use separate dimensions for width and height instead of taking the max
const basePlateWidth = totalWidth + borderSize * 2;
const basePlateHeight = totalHeight + borderSize * 2;
 
// For reading frames
const context = canvas.getContext("2d", { willReadFrequently: true });
const outputContext = outputCanvas.getContext("2d", { willReadFrequently: true });
 
let model;
let processor;
let isProcessing = false;
let previousTime;
let depthData;   // We'll store the raw depth float array here
let depthWidth;  // The model's depth-map width
let depthHeight; // The model's depth-map height
 
// 1) Load the model
statusEl.textContent = "Loading model...";
const model_id = "onnx-community/depth-anything-v2-small";
 
try {
  model = await AutoModel.from_pretrained(model_id, {
    device: "webgpu",
    dtype: (await hasFp16()) ? "fp16" : "fp32",
  });
} catch (err) {
  statusEl.textContent = err.message;
  alert(err.message);
  throw err;
}
 
processor = await AutoImageProcessor.from_pretrained(model_id);
statusEl.textContent = "Ready";
 
// 2) Allow user to change input resolution
let size = 504;
processor.size = { width: size, height: size };
sizeSlider.addEventListener("input", () => {
  size = Number(sizeSlider.value);
  processor.size = { width: size, height: size };
  sizeLabel.textContent = size;
});
sizeSlider.disabled = false;
 
// 3) Setup video
function setStreamSize(w, h) {
  video.width = outputCanvas.width = canvas.width = w;
  video.height = outputCanvas.height = canvas.height = h;
  video.style.transform = 'scaleX(-1)';
  outputCanvas.style.transform = 'scaleX(-1)';  // Mirror the depth display too
}
 
// === Quadratic interpolation helper functions ===
function lagrangeInterpolate(y0, y1, y2, t) {
  const c0 = y0 * ((t - 1) * (t - 2)) / ((0 - 1) * (0 - 2));
  const c1 = y1 * ((t - 0) * (t - 2)) / ((1 - 0) * (1 - 2));
  const c2 = y2 * ((t - 0) * (t - 1)) / ((2 - 0) * (2 - 1));
  return c0 + c1 + c2;
}
 
function sampleDepthQuadratic(u, v, data, w, h) {
  u = Math.max(1, Math.min(w - 2, u));
  v = Math.max(1, Math.min(h - 2, v));
 
  const x0 = Math.floor(u) - 1;
  const y0 = Math.floor(v) - 1;
  const x1 = x0 + 1;
  const x2 = x0 + 2;
  const y1 = y0 + 1;
  const y2 = y0 + 2;
 
  const fx = u - x0;
  const fy = v - y0;
 
  function d(x, y) {
    return data[y * w + x];
  }
 
  const row0 = lagrangeInterpolate(d(x0, y0), d(x1, y0), d(x2, y0), fx);
  const row1 = lagrangeInterpolate(d(x0, y1), d(x1, y1), d(x2, y1), fx);
  const row2 = lagrangeInterpolate(d(x0, y2), d(x1, y2), d(x2, y2), fx);
 
  return lagrangeInterpolate(row0, row1, row2, fy);
}
 
// 4) Three.js scene for pins
function initPinsScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);
 
  camera = new THREE.PerspectiveCamera(75, 800 / 600, 0.1, 1000);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(800, 600);
 
  const threeContainer = document.getElementById("three-container");
  threeContainer.appendChild(renderer.domElement);
 
  // Orbit controls
  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.screenSpacePanning = false;
  controls.minDistance = 5;
  controls.maxDistance = 80;
  controls.maxPolarAngle = Math.PI / 2;
 
  // Lights
  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.position.set(0, 5, 5);
  scene.add(light);
  scene.add(new THREE.AmbientLight(0x404040));
 
  // Build pin grid (HEX arrangement)
  const pinBodyRadius = pinRadius;
  const pinTipRadius = pinRadius * 1.4;
  const pinBodyGeometry = new THREE.CylinderGeometry(pinBodyRadius, pinBodyRadius, pinHeight - pinTipRadius, 8);
  const pinTipGeometry = new THREE.SphereGeometry(pinTipRadius, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  // Less round
  pinTipGeometry.scale(1, 0.25, 1);
 
  const material = new THREE.MeshPhongMaterial({ 
    color: 0x555555,
    shininess: 50,
    specular: 0x666666,
    metalness: 0.6,
  });
  const tipMaterial = new THREE.MeshPhongMaterial({ 
    color: 0x555555,
    shininess: 15,
    specular: 0x666666,
  });
 
  // Shift body geometry so bottom is at y=0
  pinBodyGeometry.translate(0, (pinHeight - pinTipRadius) / 2, 0);
  // Shift tip geometry to top of body
  pinTipGeometry.translate(0, pinHeight - pinTipRadius, 0);
 
  const offsetX = totalWidth / 2;
  const offsetZ = totalHeight / 2;
 
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const pinGroup = new THREE.Group();
      const pinBody = new THREE.Mesh(pinBodyGeometry, material);
      const pinTip = new THREE.Mesh(pinTipGeometry, tipMaterial);
 
      pinGroup.add(pinBody);
      pinGroup.add(pinTip);
 
      // Hex coordinate calculation
      // Row parity sets a half-offset in x
      const xPos = col * hexHorizontalSpacing + (row % 2) * (hexHorizontalSpacing / 2);
      const zPos = row * hexVerticalSpacing;
 
      // Center them by subtracting half the total dimension
      // Flip the X coordinate by negating xPos - offsetX
      pinGroup.position.x = -(xPos - offsetX);  // Added negative sign here
      pinGroup.position.z = zPos - offsetZ;
      pinGroup.position.y = 0;
 
      pins.push(pinGroup);
      scene.add(pinGroup);
    }
  }
 
  // Base plate
  const baseThickness = 0.2;
  const baseGeometry = new THREE.BoxGeometry(basePlateWidth, baseThickness, basePlateHeight);
  const baseMaterial = new THREE.MeshPhongMaterial({ color: 0x000000 });
  const base = new THREE.Mesh(baseGeometry, baseMaterial);
  base.position.set(0, baseThickness / 2 - 0.01, 0);
  scene.add(base);
 
  // Pillars
  const pillarHeight = pinDepthScale + 6.5; // Base height (6.5) plus pin movement range
  const pillarRadius = 0.8;
  const pillarCapRadius = pillarRadius * 1.2;
  const pillarGeometry = new THREE.CylinderGeometry(pillarRadius, pillarRadius, pillarHeight - pillarCapRadius, 16);
  const pillarCapGeometry = new THREE.SphereGeometry(pillarCapRadius, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  const pillarMaterial = new THREE.MeshPhongMaterial({ color: 0x333333 });
 
  // Glass pane - match base plate dimensions
  const glassThickness = 0.2;
  const glassGeometry = new THREE.BoxGeometry(basePlateWidth, glassThickness, basePlateHeight);
  const glassMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.5,
    roughness: 0.1,
    metalness: 0.1,
    transmission: 0.7,
    thickness: glassThickness,
    clearcoat: 1.0,
    clearcoatRoughness: 0.1,
    ior: 1.5,
  });
  const glass = new THREE.Mesh(glassGeometry, glassMaterial);
  glass.position.set(0, pillarHeight - 1, 0); // Position glass just below pillar tops
  scene.add(glass);
 
  // Update pillar positions to match rectangular dimensions
  const pillarPositions = [
    [-basePlateWidth / 2 + borderSize / 2, -basePlateHeight / 2 + borderSize / 2],
    [-basePlateWidth / 2 + borderSize / 2,  basePlateHeight / 2 - borderSize / 2],
    [ basePlateWidth / 2 - borderSize / 2, -basePlateHeight / 2 + borderSize / 2],
    [ basePlateWidth / 2 - borderSize / 2,  basePlateHeight / 2 - borderSize / 2],
  ];
  pillarPositions.forEach(([x, z]) => {
    const pillar = new THREE.Mesh(pillarGeometry, pillarMaterial);
    pillar.position.set(x, (pillarHeight - pillarCapRadius) / 2, z);
    scene.add(pillar);
 
    const cap = new THREE.Mesh(pillarCapGeometry, pillarMaterial);
    cap.position.set(x, pillarHeight - pillarCapRadius, z);
    scene.add(cap);
  });
 
  camera.position.set(25, 45, 40);
  camera.lookAt(0, 0, 0);
}
 
// 5) Update pins from new depth
function updatePins() {
  if (!depthData || !pins.length) return;
 
  // Find min/max to normalize from raw depth
  let minVal = Infinity;
  let maxVal = -Infinity;
  for (let i = 0; i < depthData.length; i++) {
    const v = depthData[i];
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
  }
  const range = maxVal - minVal;
 
  const skipX = depthWidth / (gridSize - 1);
  const skipY = depthHeight / (gridSize - 1);
 
  for (let i = 0; i < pins.length; i++) {
    const pinGroup = pins[i];
    const gx = i % gridSize;
    const gy = Math.floor(i / gridSize);
 
    const x = (gx + 0.5) * skipX;
    const y = (gy + 0.5) * skipY;
 
    const rawD = sampleDepthQuadratic(x, y, depthData, depthWidth, depthHeight);
    const norm = (rawD - minVal) / range;
 
    // Move the entire pin group
    pinGroup.position.y = pinDepthScale * norm;
  }
}
 
// 6) Animation loop for the 3D scene
function animate() {
  requestAnimationFrame(animate);
  updatePins();
  controls.update();
  renderer.render(scene, camera);
}
 
// 7) Process each video frame and run inference
async function runInference() {
  if (isProcessing) return;
  isProcessing = true;
 
  const { width, height } = canvas;
  context.drawImage(video, 0, 0, width, height);
  const currentFrame = context.getImageData(0, 0, width, height);
  const image = new RawImage(currentFrame.data, width, height, 4);
 
  // Pre-process
  const inputs = await processor(image);
 
  // Predict
  const { predicted_depth } = await model(inputs);
  depthData = predicted_depth.data; // Float32Array
  const [bs, oh, ow] = predicted_depth.dims;
  depthWidth = ow;
  depthHeight = oh;
 
  // Also show the depth map in outputCanvas (as alpha overlay)
  outputCanvas.width = ow;
  outputCanvas.height = oh;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < depthData.length; ++i) {
    const v = depthData[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  const imageData = new Uint8ClampedArray(4 * depthData.length);
  for (let i = 0; i < depthData.length; ++i) {
    const offset = 4 * i;
    const norm = (depthData[i] - min) / range;
    const gray = 255 * (1 - norm);
    imageData[offset + 0] = gray;
    imageData[offset + 1] = gray;
    imageData[offset + 2] = gray;
    imageData[offset + 3] = 255;
  }
  const outPixelData = new ImageData(imageData, ow, oh);
  outputContext.putImageData(outPixelData, 0, 0);
 
  // Show FPS
  if (previousTime !== undefined) {
    const fps = 1000 / (performance.now() - previousTime);
    statusEl.textContent = `FPS: ${fps.toFixed(2)}`;
  }
  previousTime = performance.now();
 
  isProcessing = false;
}
 
// 8) Continuously update
function loop() {
  window.requestAnimationFrame(loop);
  runInference();
}
 
// 9) Start up the video
navigator.mediaDevices
  .getUserMedia({ video: { width: 720, height: 720 } })
  .then((stream) => {
    video.srcObject = stream;
    video.play();
 
    const track = stream.getVideoTracks()[0];
    const { width, height } = track.getSettings();
    setStreamSize(width, height);
 
    // Initialize the Three.js pin scene
    initPinsScene();
    animate();
 
    // Start inference loop
    setTimeout(loop, 50);
  })
  .catch((error) => {
    alert(error);
  });