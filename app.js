// Global Application State & Three.js Engine Variables
let scene, camera, renderer, controls;
let currentMesh = null;
let boundingBoxMesh = null;
let gridHelper = null;
let clippingPlane = null;
let isClippingActive = false;
let currentMaterialType = 'metal';
let isWireframe = false;
let isGridVisible = true;
let isAutoRotating = false;
let currentPresetType = 'bracket';

// Standard PBR Material Definitions
const materials = {
    metal: new THREE.MeshStandardMaterial({
        color: 0x8899a6,
        metalness: 0.9,
        roughness: 0.25,
        wireframe: false,
        side: THREE.DoubleSide
    }),
    aluminum: new THREE.MeshStandardMaterial({
        color: 0xd0d8e0,
        metalness: 0.8,
        roughness: 0.4,
        wireframe: false,
        side: THREE.DoubleSide
    }),
    plastic: new THREE.MeshStandardMaterial({
        color: 0x10b981,
        metalness: 0.1,
        roughness: 0.3,
        wireframe: false,
        side: THREE.DoubleSide
    }),
    gold: new THREE.MeshStandardMaterial({
        color: 0xd4af37,
        metalness: 0.95,
        roughness: 0.15,
        wireframe: false,
        side: THREE.DoubleSide
    })
};

// Initialize Application on Load
document.addEventListener('DOMContentLoaded', () => {
    initThreeJS();
    setupEventListeners();
    generateModel(); // Initial parametric model render
});

// Initialize Three.js Viewport
function initThreeJS() {
    const container = document.getElementById('threejs-canvas-container');
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0f19);
    scene.fog = new THREE.FogExp2(0x0b0f19, 0.0025);

    // Section Clipping Plane
    clippingPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 25);
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.localClippingEnabled = true;
    container.appendChild(renderer.domElement);

    // Camera
    camera = new THREE.PerspectiveCamera(45, width / height, 1, 2500);
    camera.position.set(160, 130, 190);

    // Controls
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.target.set(0, 25, 0);

    // Lighting Setup
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
    scene.add(ambientLight);

    const mainLight = new THREE.DirectionalLight(0xffffff, 1.2);
    mainLight.position.set(200, 300, 200);
    mainLight.castShadow = true;
    mainLight.shadow.mapSize.width = 2048;
    mainLight.shadow.mapSize.height = 2048;
    scene.add(mainLight);

    const rimLight = new THREE.DirectionalLight(0x00f2fe, 0.6);
    rimLight.position.set(-200, -100, -200);
    scene.add(rimLight);

    const accentLight = new THREE.PointLight(0x8b5cf6, 0.8, 400);
    accentLight.position.set(0, 120, 0);
    scene.add(accentLight);

    // Ground Grid Helper
    gridHelper = new THREE.GridHelper(400, 40, 0x00f2fe, 0x1e293b);
    gridHelper.position.y = -0.5;
    scene.add(gridHelper);

    // Window Resize Handler
    window.addEventListener('resize', onWindowResize);

    // Render Loop
    animate();
}

function onWindowResize() {
    const container = document.getElementById('threejs-canvas-container');
    if (!container) return;
    const width = container.clientWidth;
    const height = container.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
}

function animate() {
    requestAnimationFrame(animate);

    if (isAutoRotating && currentMesh) {
        currentMesh.rotation.y += 0.008;
    }

    controls.update();
    renderer.render(scene, camera);
}

// Dimension Validation Rule Engine
function validateInputs(length, width, height, hole) {
    const errorBanner = document.getElementById('validation-error');
    const errorText = document.getElementById('error-text');

    if (length <= 0 || width <= 0 || height <= 0) {
        errorText.textContent = "O'lchamlar 0 dan katta bo'lishi kerak.";
        errorBanner.style.display = 'flex';
        return false;
    }

    const minBase = Math.min(length, width);
    if (hole >= minBase) {
        errorText.textContent = `Teshik diametri (${hole}mm) detal o'lchamidan (${minBase}mm) kichik bo'lishi kerak.`;
        errorBanner.style.display = 'flex';
        return false;
    }

    errorBanner.style.display = 'none';
    return true;
}

// Generate Parametric 3D Geometries
function generateModel() {
    const length = parseFloat(document.getElementById('dim-length').value) || 120;
    const width = parseFloat(document.getElementById('dim-width').value) || 80;
    const height = parseFloat(document.getElementById('dim-height').value) || 50;
    const holeDiameter = parseFloat(document.getElementById('dim-hole').value) || 25;
    const holeRadius = holeDiameter / 2;

    if (!validateInputs(length, width, height, holeDiameter)) {
        return;
    }

    // Clean up existing meshes
    if (currentMesh) {
        scene.remove(currentMesh);
        if (currentMesh.geometry) currentMesh.geometry.dispose();
    }
    if (boundingBoxMesh) {
        scene.remove(boundingBoxMesh);
    }

    let geometry;

    if (currentPresetType === 'bracket') {
        // Flanes / Kronshteyn Parametric Extrusion
        const shape = new THREE.Shape();
        const l2 = length / 2;
        const w2 = width / 2;
        const radius = Math.min(length, width) * 0.15;

        shape.moveTo(-l2 + radius, -w2);
        shape.lineTo(l2 - radius, -w2);
        shape.quadraticCurveTo(l2, -w2, l2, -w2 + radius);
        shape.lineTo(l2, w2 - radius);
        shape.quadraticCurveTo(l2, w2, l2 - radius, w2);
        shape.lineTo(-l2 + radius, w2);
        shape.quadraticCurveTo(-l2, w2, -l2, w2 - radius);
        shape.lineTo(-l2, -w2 + radius);
        shape.quadraticCurveTo(-l2, -w2, -l2 + radius, -w2);

        // Center Hole
        if (holeRadius > 0 && holeRadius < Math.min(l2, w2)) {
            const holePath = new THREE.Path();
            holePath.absarc(0, 0, holeRadius, 0, Math.PI * 2, true);
            shape.holes.push(holePath);

            // Bolt Holes
            const cornerX = l2 - radius;
            const cornerY = w2 - radius;
            const boltR = Math.max(3, holeRadius * 0.25);
            [[-cornerX, -cornerY], [cornerX, -cornerY], [cornerX, cornerY], [-cornerX, cornerY]].forEach(pt => {
                const bHole = new THREE.Path();
                bHole.absarc(pt[0], pt[1], boltR, 0, Math.PI * 2, true);
                shape.holes.push(bHole);
            });
        }

        const extrudeSettings = {
            steps: 2,
            depth: height,
            bevelEnabled: true,
            bevelThickness: 2,
            bevelSize: 1.5,
            bevelSegments: 3
        };

        geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
        geometry.rotateX(-Math.PI / 2);
        geometry.center();
        geometry.translate(0, height / 2, 0);

    } else if (currentPresetType === 'gear') {
        // Shesterens / Gear Extrusion
        const teeth = 16;
        const outerR = Math.min(length, width) / 2;
        const innerR = outerR * 0.75;
        const holeR = Math.min(holeRadius, innerR * 0.5);

        const shape = new THREE.Shape();
        for (let i = 0; i < teeth; i++) {
            const a1 = (i / teeth) * Math.PI * 2;
            const a2 = ((i + 0.3) / teeth) * Math.PI * 2;
            const a3 = ((i + 0.5) / teeth) * Math.PI * 2;
            const a4 = ((i + 0.8) / teeth) * Math.PI * 2;

            if (i === 0) shape.moveTo(Math.cos(a1) * innerR, Math.sin(a1) * innerR);
            else shape.lineTo(Math.cos(a1) * innerR, Math.sin(a1) * innerR);

            shape.lineTo(Math.cos(a2) * outerR, Math.sin(a2) * outerR);
            shape.lineTo(Math.cos(a3) * outerR, Math.sin(a3) * outerR);
            shape.lineTo(Math.cos(a4) * innerR, Math.sin(a4) * innerR);
        }

        if (holeR > 0) {
            const holePath = new THREE.Path();
            holePath.absarc(0, 0, holeR, 0, Math.PI * 2, true);
            shape.holes.push(holePath);
        }

        geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: true, bevelThickness: 1, bevelSize: 1 });
        geometry.rotateX(-Math.PI / 2);
        geometry.center();
        geometry.translate(0, height / 2, 0);

    } else if (currentPresetType === 'cylinder') {
        // Hollow Cylinder / Vtulka
        const outerR = Math.min(length, width) / 2;
        geometry = new THREE.CylinderGeometry(outerR, outerR, height, 48);
        geometry.translate(0, height / 2, 0);

    } else {
        // Combined Custom Mechanical Assembly
        const group = new THREE.Group();
        const baseGeo = new THREE.BoxGeometry(length, height * 0.4, width);
        const baseMat = materials[currentMaterialType].clone();
        baseMat.wireframe = isWireframe;
        if (isClippingActive) baseMat.clippingPlanes = [clippingPlane];

        const baseMesh = new THREE.Mesh(baseGeo, baseMat);
        baseMesh.position.y = (height * 0.4) / 2;
        baseMesh.castShadow = true;
        baseMesh.receiveShadow = true;

        const topCylGeo = new THREE.CylinderGeometry(holeRadius * 1.5, holeRadius * 1.5, height * 0.6, 32);
        const topCylMesh = new THREE.Mesh(topCylGeo, baseMat);
        topCylMesh.position.y = (height * 0.4) + (height * 0.3);
        topCylMesh.castShadow = true;

        group.add(baseMesh);
        group.add(topCylMesh);

        currentMesh = group;
        scene.add(currentMesh);
        updateModelStats(length, width, height, 6420);
        return;
    }

    // Apply Active Material
    const activeMat = materials[currentMaterialType].clone();
    activeMat.wireframe = isWireframe;
    if (isClippingActive) activeMat.clippingPlanes = [clippingPlane];

    currentMesh = new THREE.Mesh(geometry, activeMat);
    currentMesh.castShadow = true;
    currentMesh.receiveShadow = true;
    scene.add(currentMesh);

    // Compute Bounding Box & Stats
    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox;
    const polyCount = geometry.attributes.position.count;
    updateModelStats(length, width, height, polyCount);

    // Create 3D Dimension Box Marker
    createBoundingBoxOverlay(bbox);
}

// Bounding Box 3D Measurement Overlay
function createBoundingBoxOverlay(bbox) {
    if (boundingBoxMesh) scene.remove(boundingBoxMesh);

    const boxGeo = new THREE.BoxGeometry(
        bbox.max.x - bbox.min.x + 2,
        bbox.max.y - bbox.min.y + 2,
        bbox.max.z - bbox.min.z + 2
    );
    const wireframeGeo = new THREE.WireframeGeometry(boxGeo);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x00f2fe, opacity: 0.35, transparent: true });
    
    boundingBoxMesh = new THREE.LineSegments(wireframeGeo, lineMat);
    boundingBoxMesh.position.set(
        (bbox.max.x + bbox.min.x) / 2,
        (bbox.max.y + bbox.min.y) / 2,
        (bbox.max.z + bbox.min.z) / 2
    );
    boundingBoxMesh.visible = isGridVisible;
    scene.add(boundingBoxMesh);
}

// Update Stats UI
function updateModelStats(l, w, h, polyCount) {
    document.getElementById('poly-count').textContent = polyCount.toLocaleString();
    document.getElementById('dim-summary').textContent = `${l} x ${w} x ${h} mm`;
    const vol = Math.round((l * w * h) / 1000);
    document.getElementById('volume-summary').textContent = `${vol} cm³`;
}

// Event Listeners
function setupEventListeners() {
    ['dim-length', 'dim-width', 'dim-height', 'dim-hole'].forEach(id => {
        document.getElementById(id).addEventListener('input', generateModel);
    });

    // Preset Shape Buttons
    document.querySelectorAll('.btn-chip').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.btn-chip').forEach(b => b.classList.remove('active'));
            const target = e.currentTarget;
            target.classList.add('active');
            currentPresetType = target.getAttribute('data-type');
            generateModel();
        });
    });

    // Material Picker Buttons
    document.querySelectorAll('.mat-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.mat-btn').forEach(b => b.classList.remove('active'));
            const target = e.currentTarget;
            target.classList.add('active');
            currentMaterialType = target.getAttribute('data-material');
            
            if (currentMesh) {
                if (currentMesh.isGroup) {
                    currentMesh.children.forEach(c => {
                        c.material = materials[currentMaterialType].clone();
                        c.material.wireframe = isWireframe;
                        if (isClippingActive) c.material.clippingPlanes = [clippingPlane];
                    });
                } else {
                    currentMesh.material = materials[currentMaterialType].clone();
                    currentMesh.material.wireframe = isWireframe;
                    if (isClippingActive) currentMesh.material.clippingPlanes = [clippingPlane];
                }
            }
        });
    });

    // Calibration Select
    document.getElementById('sel-calibration').addEventListener('change', (e) => {
        const val = e.target.value;
        if (val === 'coin_500') {
            document.getElementById('dim-hole').value = 24;
        } else if (val === 'credit_card') {
            document.getElementById('dim-length').value = 85.6;
        }
        generateModel();
    });

    // Generate Button
    document.getElementById('btn-generate').addEventListener('click', runAISimulation);
    document.getElementById('btn-example-load').addEventListener('click', loadExampleDetail);

    // AR Guide Modal
    document.getElementById('btn-ar-guide').addEventListener('click', () => {
        document.getElementById('ar-guide-modal').classList.add('active');
    });

    // Viewport Controls
    document.getElementById('btn-reset-view').addEventListener('click', () => {
        camera.position.set(160, 130, 190);
        controls.target.set(0, 25, 0);
        controls.update();
    });

    document.getElementById('btn-toggle-wireframe').addEventListener('click', (e) => {
        isWireframe = !isWireframe;
        e.currentTarget.classList.toggle('active', isWireframe);
        if (currentMesh) {
            if (currentMesh.isGroup) {
                currentMesh.children.forEach(c => c.material.wireframe = isWireframe);
            } else {
                currentMesh.material.wireframe = isWireframe;
            }
        }
    });

    document.getElementById('btn-toggle-grid').addEventListener('click', (e) => {
        isGridVisible = !isGridVisible;
        e.currentTarget.classList.toggle('active', isGridVisible);
        gridHelper.visible = isGridVisible;
        if (boundingBoxMesh) boundingBoxMesh.visible = isGridVisible;
    });

    document.getElementById('btn-toggle-clipping').addEventListener('click', (e) => {
        isClippingActive = !isClippingActive;
        e.currentTarget.classList.toggle('active', isClippingActive);
        generateModel();
    });

    document.getElementById('btn-toggle-rotate').addEventListener('click', (e) => {
        isAutoRotating = !isAutoRotating;
        e.currentTarget.classList.toggle('active', isAutoRotating);
    });

    // Export Modal Trigger
    document.getElementById('btn-export-modal').addEventListener('click', () => {
        document.getElementById('export-modal').classList.add('active');
    });

    // File Input Dropzone
    const fileInput = document.getElementById('file-input');
    fileInput.addEventListener('change', handleFileSelect);

    const uploadZone = document.getElementById('upload-zone');
    uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadZone.classList.add('dragover');
    });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.classList.remove('dragover');
        if (e.dataTransfer.files.length) {
            fileInput.files = e.dataTransfer.files;
            handleFileSelect();
        }
    });
}

function handleFileSelect() {
    const files = document.getElementById('file-input').files;
    const container = document.getElementById('media-preview-container');
    container.innerHTML = '';

    Array.from(files).forEach((file, idx) => {
        const thumb = document.createElement('div');
        thumb.className = 'media-thumb';
        const url = URL.createObjectURL(file);

        if (file.type.startsWith('image/')) {
            thumb.innerHTML = `<img src="${url}" alt="Upload ${idx}">`;
        } else {
            thumb.innerHTML = `<video src="${url}" muted autoplay loop></video>`;
        }

        container.appendChild(thumb);
    });

    if (files.length > 0) {
        runAISimulation();
    }
}

function runAISimulation() {
    const overlay = document.getElementById('loading-overlay');
    const progressFill = document.getElementById('progress-fill');
    const loadingText = document.getElementById('loading-step-text');
    const statusText = document.getElementById('status-text');

    overlay.classList.add('active');
    statusText.textContent = "AI Tahlil va 3D Mesh Yaratilmoqda...";

    const steps = [
        { progress: 20, text: "Fotogrammetriya va NeRF nurlar tahlil qilinmoqda..." },
        { progress: 45, text: "Burchak va teshiklar parametri (CAD Snap) aniqlanmoqda..." },
        { progress: 75, text: "Ko'rinmagan orqa yuzalar AI Infilling bilan tiklanmoqda..." },
        { progress: 95, text: "3D Watertight STL poligon to'ri zichlashtirilmoqda..." },
        { progress: 100, text: "3D Model tayyor!" }
    ];

    let currentStep = 0;
    const interval = setInterval(() => {
        if (currentStep < steps.length) {
            const step = steps[currentStep];
            progressFill.style.width = step.progress + '%';
            loadingText.textContent = step.text;
            currentStep++;
        } else {
            clearInterval(interval);
            setTimeout(() => {
                overlay.classList.remove('active');
                generateModel();
                statusText.textContent = "3D Model Muvaffaqiyatli Yaratildi";
            }, 350);
        }
    }, 400);
}

function loadExampleDetail() {
    document.getElementById('dim-length').value = 140;
    document.getElementById('dim-width').value = 90;
    document.getElementById('dim-height').value = 45;
    document.getElementById('dim-hole').value = 30;

    const container = document.getElementById('media-preview-container');
    container.innerHTML = `
        <div class="media-thumb">
            <img src="https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=200&auto=format&fit=crop&q=80" alt="Mechanical part demo">
        </div>
    `;

    runAISimulation();
}

function exportModel(format) {
    const filename = `AI_CAD_Detail_Model_${Date.now()}.${format}`;
    const l = document.getElementById('dim-length').value;
    const w = document.getElementById('dim-width').value;
    const h = document.getElementById('dim-height').value;

    let dummyContent = '';
    if (format === 'step') {
        dummyContent = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('AI CAD Parametric Solid Model'),'2;1');\nFILE_NAME('${filename}','2026-07-25',('Antigravity'),('AI CAD Engine'),'OpenCASCADE 7.6','','');\nENDSEC;\nDATA;\n/* CARTESIAN_POINT Dimensions: L=${l}, W=${w}, H=${h} mm */\n#1=CARTESIAN_POINT('',(0.0,0.0,0.0));\nENDSEC;\nEND-ISO-10303-21;\n`;
    } else {
        dummyContent = `solid AI_CAD_Detail_${currentPresetType}\n  comment Generated by AI 3D Reconstruction Engine\n  comment Dimensions: ${l}x${w}x${h} mm\nendsolid AI_CAD_Detail_${currentPresetType}\n`;
    }

    const blob = new Blob([dummyContent], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();

    document.getElementById('export-modal').classList.remove('active');
    alert(`Muvaffaqiyatli! ${filename} fayli kompyuterga yuklab olindi.`);
}
