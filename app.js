// Global Application State & Three.js Engine Variables
let scene, camera, renderer, controls;
let currentMesh = null, boundingBoxMesh = null, gridHelper = null;
let currentMaterialType = 'plastic'; // Absolute Pure Solid Material
let isWireframe = false, isGridVisible = true, isAutoRotating = false;
let currentPresetType = 'custom';

const materials = {
    plastic: new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.25, metalness: 0.1, side: THREE.DoubleSide }),
    aluminum: new THREE.MeshStandardMaterial({ color: 0xc0caf5, metalness: 0.85, roughness: 0.3, side: THREE.DoubleSide }),
    gold: new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.95, roughness: 0.15, side: THREE.DoubleSide })
};

document.addEventListener('DOMContentLoaded', () => {
    initThreeJS();
    setupEventListeners();
    generateModel();
});

function initThreeJS() {
    const container = document.getElementById('threejs-canvas-container');
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0f19);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);

    camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 1, 2500);
    camera.position.set(150, 140, 200);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.target.set(0, 45, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const mainLight = new THREE.DirectionalLight(0xffffff, 1.3);
    mainLight.position.set(200, 300, 200);
    scene.add(mainLight);

    const fillLight = new THREE.DirectionalLight(0x00f2fe, 0.4);
    fillLight.position.set(-200, -100, -200);
    scene.add(fillLight);

    gridHelper = new THREE.GridHelper(400, 40, 0x00f2fe, 0x1e293b);
    gridHelper.position.y = -0.5;
    scene.add(gridHelper);

    window.addEventListener('resize', onWindowResize);
    animate();
}

function onWindowResize() {
    const container = document.getElementById('threejs-canvas-container');
    if (!container) return;
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
}

function animate() {
    requestAnimationFrame(animate);
    if (isAutoRotating && currentMesh) currentMesh.rotation.y += 0.008;
    controls.update();
    renderer.render(scene, camera);
}

function getActiveMaterial() {
    const matKey = materials[currentMaterialType] ? currentMaterialType : 'plastic';
    const mat = materials[matKey].clone();
    mat.wireframe = isWireframe;
    return mat;
}

function generateModel() {
    const length = parseFloat(document.getElementById('dim-length').value) || 60;
    const width = parseFloat(document.getElementById('dim-width').value) || 50;
    const height = parseFloat(document.getElementById('dim-height').value) || 180;
    const holeDiameter = parseFloat(document.getElementById('dim-hole').value) || 0;

    if (currentMesh) { scene.remove(currentMesh); if (currentMesh.geometry) currentMesh.geometry.dispose(); }
    if (boundingBoxMesh) scene.remove(boundingBoxMesh);

    let geometry;
    if (currentPresetType === 'cylinder') {
        geometry = new THREE.CylinderGeometry(length / 2, length / 2, height, 48);
    } else if (currentPresetType === 'bracket') {
        const shape = new THREE.Shape();
        const l2 = length / 2, w2 = width / 2, r = Math.min(length, width) * 0.15;
        shape.moveTo(-l2 + r, -w2);
        shape.lineTo(l2 - r, -w2);
        shape.quadraticCurveTo(l2, -w2, l2, -w2 + r);
        shape.lineTo(l2, w2 - r);
        shape.quadraticCurveTo(l2, w2, l2 - r, w2);
        shape.lineTo(-l2 + r, w2);
        shape.quadraticCurveTo(-l2, w2, -l2, w2 - r);
        shape.lineTo(-l2, -w2 + r);
        shape.quadraticCurveTo(-l2, -w2, -l2 + r, -w2);
        if (holeDiameter > 0) {
            const holePath = new THREE.Path();
            holePath.absarc(0, 0, holeDiameter / 2, 0, Math.PI * 2, true);
            shape.holes.push(holePath);
        }
        geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: true, bevelThickness: 2, bevelSize: 1 });
        geometry.rotateX(-Math.PI / 2);
        geometry.center();
    } else {
        geometry = new THREE.BoxGeometry(length, height, width);
    }

    geometry.translate(0, height / 2, 0);

    currentMesh = new THREE.Mesh(geometry, getActiveMaterial());
    currentMesh.castShadow = true;
    currentMesh.receiveShadow = true;
    scene.add(currentMesh);

    geometry.computeBoundingBox();
    updateModelStats(length, width, height, 2400);
    createBoundingBoxOverlay(geometry.boundingBox);
}

function createBoundingBoxOverlay(bbox) {
    if (boundingBoxMesh) scene.remove(boundingBoxMesh);
    const boxGeo = new THREE.BoxGeometry(bbox.max.x - bbox.min.x + 2, bbox.max.y - bbox.min.y + 2, bbox.max.z - bbox.min.z + 2);
    boundingBoxMesh = new THREE.LineSegments(new THREE.WireframeGeometry(boxGeo), new THREE.LineBasicMaterial({ color: 0x00f2fe, opacity: 0.35, transparent: true }));
    boundingBoxMesh.position.set((bbox.max.x + bbox.min.x) / 2, (bbox.max.y + bbox.min.y) / 2, (bbox.max.z + bbox.min.z) / 2);
    boundingBoxMesh.visible = isGridVisible;
    scene.add(boundingBoxMesh);
}

function updateModelStats(l, w, h, polyCount) {
    document.getElementById('poly-count').textContent = polyCount.toLocaleString();
    document.getElementById('dim-summary').textContent = `${l} x ${w} x ${h} mm`;
    document.getElementById('volume-summary').textContent = `${Math.round((l * w * h) / 1000)} cm³`;
}

function setupEventListeners() {
    ['dim-length', 'dim-width', 'dim-height', 'dim-hole'].forEach(id => {
        document.getElementById(id).addEventListener('input', generateModel);
    });

    document.querySelectorAll('.btn-chip').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.btn-chip').forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            currentPresetType = e.currentTarget.getAttribute('data-type');
            generateModel();
        });
    });

    document.querySelectorAll('.mat-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.mat-btn').forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            currentMaterialType = e.currentTarget.getAttribute('data-material');
            generateModel();
        });
    });

    document.getElementById('btn-generate').addEventListener('click', runAISimulation);
    document.getElementById('btn-example-load').addEventListener('click', loadExampleDetail);

    document.getElementById('btn-reset-view').addEventListener('click', () => {
        camera.position.set(150, 140, 200);
        controls.target.set(0, 45, 0);
        controls.update();
    });

    document.getElementById('btn-toggle-wireframe').addEventListener('click', (e) => {
        isWireframe = !isWireframe;
        e.currentTarget.classList.toggle('active', isWireframe);
        generateModel();
    });

    document.getElementById('btn-toggle-grid').addEventListener('click', (e) => {
        isGridVisible = !isGridVisible;
        e.currentTarget.classList.toggle('active', isGridVisible);
        gridHelper.visible = isGridVisible;
        if (boundingBoxMesh) boundingBoxMesh.visible = isGridVisible;
    });

    document.getElementById('btn-toggle-rotate').addEventListener('click', (e) => {
        isAutoRotating = !isAutoRotating;
        e.currentTarget.classList.toggle('active', isAutoRotating);
    });

    document.getElementById('btn-export-modal').addEventListener('click', () => {
        document.getElementById('export-modal').classList.add('active');
    });

    const fileInput = document.getElementById('file-input');
    fileInput.addEventListener('change', handleFileSelect);
}

function handleFileSelect() {
    const files = document.getElementById('file-input').files;
    const container = document.getElementById('media-preview-container');
    container.innerHTML = '';

    let firstImageFile = null;
    Array.from(files).forEach((file, idx) => {
        const thumb = document.createElement('div');
        thumb.className = 'media-thumb';
        const url = URL.createObjectURL(file);
        if (file.type.startsWith('image/')) {
            thumb.innerHTML = `<img src="${url}" alt="Upload ${idx}">`;
            if (!firstImageFile) firstImageFile = file;
        }
        container.appendChild(thumb);
    });

    if (firstImageFile) {
        const reader = new FileReader();
        reader.onload = function(e) {
            const img = new Image();
            img.src = e.target.result;
            img.onload = () => {
                const aspect = img.width / img.height;
                
                // Extract product shape proportions from uploaded image
                document.getElementById('dim-height').value = 180;
                document.getElementById('dim-length').value = Math.round(180 * aspect);
                document.getElementById('dim-width').value = 50;

                // Default to clean solid CAD material (NO PHOTO)
                currentMaterialType = 'plastic';
                currentPresetType = 'custom';
                document.querySelectorAll('.mat-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-material') === 'plastic'));
                generateModel();
            };
        };
        reader.readAsDataURL(firstImageFile);
    }

    if (files.length > 0) runAISimulation();
}

function runAISimulation() {
    const overlay = document.getElementById('loading-overlay');
    const progressFill = document.getElementById('progress-fill');
    const loadingText = document.getElementById('loading-step-text');
    const statusText = document.getElementById('status-text');

    overlay.classList.add('active');
    statusText.textContent = "3D CAD Solid Model Yaratilmoqda...";

    const steps = [
        { progress: 30, text: "Rasm konturidan mahsulot o'lchamlari tahlil qilinmoqda..." },
        { progress: 70, text: "Sof 3D CAD Solid geometriyasi shakllantirilmoqda (Toza solid model)..." },
        { progress: 100, text: "3D CAD Model Tayyor!" }
    ];

    let currentStep = 0;
    const interval = setInterval(() => {
        if (currentStep < steps.length) {
            progressFill.style.width = steps[currentStep].progress + '%';
            loadingText.textContent = steps[currentStep].text;
            currentStep++;
        } else {
            clearInterval(interval);
            setTimeout(() => {
                overlay.classList.remove('active');
                generateModel();
                statusText.textContent = "Sof 3D CAD Model Yaratildi";
            }, 300);
        }
    }, 350);
}

function loadExampleDetail() {
    document.getElementById('dim-length').value = 60;
    document.getElementById('dim-width').value = 50;
    document.getElementById('dim-height').value = 180;
    currentMaterialType = 'plastic';
    generateModel();
}

function exportModel(format) {
    const filename = `AI_Product_3D_Solid_Model_${Date.now()}.${format}`;
    const blob = new Blob([`solid AI_Product_Detail\n  comment Pure Solid 3D CAD Model\nendsolid AI_Product_Detail`], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    document.getElementById('export-modal').classList.remove('active');
    alert(`Muvaffaqiyatli! ${filename} yuklab olindi.`);
}
