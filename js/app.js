/* AI-CAD 3D — browser application (UI, Three.js viewer, export). */
(function () {
    'use strict';

    const G = window.CadGeo;
    const D = window.CadDrawing;
    const M = window.CadMesher;
    const $ = id => document.getElementById(id);

    const DENSITY = { plastic: 1.24, aluminum: 2.70, gold: 8.50 };  // g/cm³ (PLA, Al, brass)
    const MATERIALS = {
        plastic: { color: 0xf1f5f9, roughness: 0.35, metalness: 0.05 },
        aluminum: { color: 0xc0caf5, roughness: 0.3, metalness: 0.85 },
        gold: { color: 0xd4af37, roughness: 0.2, metalness: 0.9 }
    };
    // starting dimensions when a preset chip is clicked: [L, W, H, param]
    const PRESET_DIMS = {
        spray_bottle: [60, 60, 180, 15],
        bevel_box: [80, 60, 40, 6],
        flange: [80, 60, 12, 20],
        tube: [40, 40, 60, 30]
    };

    const state = {
        preset: 'spray_bottle',
        material: 'plastic',
        wireframe: false, grid: true, dims: true, section: false, rotate: false,
        contour: null, contourSource: null,
        spec: null,            // null when showing an imported STL
        soup: null,            // Float32Array triangle soup currently displayed
        report: null,
        modelName: 'model',
        api: null,
        drawing: null,         // { spec, analysis } from /api/drawing/analyze
        drawingFile: null
    };

    let scene, camera, renderer, controls, gridHelper, modelGroup, mesh, dimsGroup;
    const sectionPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);

    // ------------------------------------------------------------------ viewer

    function initViewer() {
        const box = $('threejs-canvas-container');
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0b0f19);

        renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(box.clientWidth, box.clientHeight);
        renderer.localClippingEnabled = true;
        box.appendChild(renderer.domElement);

        camera = new THREE.PerspectiveCamera(45, box.clientWidth / box.clientHeight, 0.5, 20000);
        controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;

        scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 0.75));
        const key = new THREE.DirectionalLight(0xffffff, 0.9);
        key.position.set(1, 1.6, 1.2);
        scene.add(key);
        const rim = new THREE.DirectionalLight(0x7dd3fc, 0.35);
        rim.position.set(-1.2, 0.4, -1);
        scene.add(rim);

        modelGroup = new THREE.Group();
        scene.add(modelGroup);

        new ResizeObserver(onResize).observe(box);
        renderer.setAnimationLoop(() => {
            if (state.rotate) modelGroup.rotation.y += 0.008;
            controls.update();
            renderer.render(scene, camera);
        });
    }

    function onResize() {
        const box = $('threejs-canvas-container');
        if (!box.clientWidth || !box.clientHeight) return;
        camera.aspect = box.clientWidth / box.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(box.clientWidth, box.clientHeight);
    }

    function makeMaterial() {
        return new THREE.MeshStandardMaterial(Object.assign({}, MATERIALS[state.material], {
            wireframe: state.wireframe,
            side: THREE.DoubleSide,          // shows the inside when sectioned
            clippingPlanes: state.section ? [sectionPlane] : [],
            flatShading: false
        }));
    }

    function setGeometry(geometry) {
        if (mesh) { modelGroup.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
        mesh = new THREE.Mesh(geometry, makeMaterial());
        modelGroup.add(mesh);
        geometry.computeBoundingBox();
        rebuildGrid(geometry.boundingBox);
        rebuildDims(geometry.boundingBox);
        updateSection();
    }

    function rebuildGrid(bb) {
        if (gridHelper) { scene.remove(gridHelper); gridHelper.geometry.dispose(); }
        const size = bb.getSize(new THREE.Vector3());
        const span = Math.max(size.x, size.z) * 2.5;
        const step = niceStep(span / 20);
        const divisions = Math.max(10, Math.ceil(span / step));
        gridHelper = new THREE.GridHelper(divisions * step, divisions, 0x0ea5b7, 0x1e293b);
        gridHelper.position.y = bb.min.y - 0.01;
        gridHelper.visible = state.grid;
        scene.add(gridHelper);
    }

    function niceStep(x) {
        const p = Math.pow(10, Math.floor(Math.log10(x)));
        return [1, 2, 5, 10].map(m => m * p).find(v => v >= x);
    }

    function fitCamera() {
        if (!mesh) return;
        const bb = mesh.geometry.boundingBox;
        const center = bb.getCenter(new THREE.Vector3());
        const radius = bb.getSize(new THREE.Vector3()).length() / 2;
        const vfov = THREE.MathUtils.degToRad(camera.fov);
        const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
        const dist = radius * 1.35 / Math.sin(Math.min(vfov, hfov) / 2);   // margin for dimension labels
        const dir = new THREE.Vector3(0.9, 0.65, 1.2).normalize();
        camera.position.copy(center).addScaledVector(dir, dist);
        camera.near = dist / 100;
        camera.far = dist * 20;
        camera.updateProjectionMatrix();
        controls.target.copy(center);
        modelGroup.rotation.set(0, 0, 0);
        controls.update();
    }

    // ------------------------------------------------- dimension annotations

    function label(text, scale) {
        const c = document.createElement('canvas');
        const ctx = c.getContext('2d');
        const font = 'bold 44px "Space Grotesk", sans-serif';
        ctx.font = font;
        c.width = Math.ceil(ctx.measureText(text).width) + 28;
        c.height = 64;
        ctx.font = font;
        ctx.fillStyle = 'rgba(11,15,25,0.85)';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.fillStyle = '#00f2fe';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 14, 34);
        const tex = new THREE.CanvasTexture(c);
        tex.minFilter = THREE.LinearFilter;
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
        sprite.scale.set(scale * c.width / c.height, scale, 1);
        sprite.renderOrder = 10;
        return sprite;
    }

    function rebuildDims(bb) {
        if (dimsGroup) {
            dimsGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
            modelGroup.remove(dimsGroup);
        }
        dimsGroup = new THREE.Group();
        dimsGroup.visible = state.dims;
        const size = bb.getSize(new THREE.Vector3());
        const off = Math.max(size.x, size.y, size.z) * 0.08;
        const ls = Math.max(size.x, size.y, size.z) * 0.045;
        const mat = new THREE.LineBasicMaterial({ color: 0x00f2fe, depthTest: false, transparent: true, opacity: 0.9 });
        const tick = off * 0.35;

        const dim = (a, b, tickDir, text, labelOffset) => {
            const pts = [a, b,
                a.clone().addScaledVector(tickDir, tick), a.clone().addScaledVector(tickDir, -tick),
                b.clone().addScaledVector(tickDir, tick), b.clone().addScaledVector(tickDir, -tick)];
            const line = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), mat);
            line.renderOrder = 9;
            dimsGroup.add(line);
            const s = label(text, ls);
            s.position.copy(a).add(b).multiplyScalar(0.5).add(labelOffset);
            dimsGroup.add(s);
        };
        const fmt = v => (Math.round(v * 10) / 10) + ' mm';
        const { min, max } = bb;
        const zf = max.z + off;
        dim(new THREE.Vector3(min.x, min.y, zf), new THREE.Vector3(max.x, min.y, zf), new THREE.Vector3(0, 0, 1), 'L ' + fmt(size.x), new THREE.Vector3(0, -ls * 0.9, 0));
        const xf = max.x + off;
        dim(new THREE.Vector3(xf, min.y, min.z), new THREE.Vector3(xf, min.y, max.z), new THREE.Vector3(1, 0, 0), 'W ' + fmt(size.z), new THREE.Vector3(0, -ls * 0.9, 0));
        const xb = min.x - off;
        dim(new THREE.Vector3(xb, min.y, zf), new THREE.Vector3(xb, max.y, zf), new THREE.Vector3(1, 0, 0), 'H ' + fmt(size.y), new THREE.Vector3(-ls * 2.4, 0, 0));
        modelGroup.add(dimsGroup);
    }

    // ------------------------------------------------------- section clipping

    function updateSection() {
        $('section-controls').classList.toggle('hidden', !state.section);
        if (!mesh) return;
        mesh.material.clippingPlanes = state.section ? [sectionPlane] : [];
        mesh.material.needsUpdate = true;
        if (!state.section) return;
        const bb = mesh.geometry.boundingBox;
        const axis = $('section-axis').value;
        const t = $('section-pos').value / 100;
        const n = { x: new THREE.Vector3(-1, 0, 0), y: new THREE.Vector3(0, -1, 0), z: new THREE.Vector3(0, 0, -1) }[axis];
        const pos = bb.min[axis] + (bb.max[axis] - bb.min[axis]) * t;
        sectionPlane.normal.copy(n);
        sectionPlane.constant = pos;   // keeps everything with coordinate <= pos
    }

    // ------------------------------------------------------------ model build

    function readDims() {
        return {
            length: parseFloat($('dim-length').value),
            width: parseFloat($('dim-width').value),
            height: parseFloat($('dim-height').value),
            param: parseFloat($('dim-param').value) || 0
        };
    }

    function rebuild(opts) {
        opts = opts || {};
        if (state.preset === 'contour' && state.contour && state.contour.mode === 'revolve') $('dim-width').value = $('dim-length').value;
        if (state.preset === 'drawing') return showSpec(state.drawing.spec, state.drawing.spec.name || 'chizma', opts);
        const dims = readDims();
        const { errors, warnings } = G.validate(state.preset, dims);
        renderMessages($('validation-messages'), errors.map(e => ['error', e]).concat(warnings.map(w => ['warn', w])));
        if (errors.length) { setStatus('error', "O'lchamlarda xato — model yangilanmadi"); return; }

        try {
            state.spec = G.buildSpec(state.preset, dims, state.contour);
            const geo = M.specToGeometry(THREE, state.spec);
            state.soup = geo.attributes.position.array;
            state.modelName = state.preset;
            setGeometry(geo);
            analyze();
            if (opts.fit) fitCamera();
        } catch (err) {
            console.error(err);
            setStatus('error', err.message);
        }
    }

    function showSpec(spec, name, opts) {
        try {
            state.spec = spec;
            const geo = M.specToGeometry(THREE, spec);
            state.soup = geo.attributes.position.array;
            state.modelName = name.replace(/[^A-Za-z0-9_-]+/g, '_') || 'model';
            setGeometry(geo);
            analyze();
            if (opts && opts.fit) fitCamera();
        } catch (err) {
            console.error(err);
            setStatus('error', err.message);
        }
    }

    function analyze() {
        const r = G.analyzeMesh(state.soup);
        state.report = r;
        $('poly-count').textContent = r.triangles.toLocaleString();
        $('dim-summary').textContent = r.size.map(v => (Math.round(v * 10) / 10)).join(' × ') + ' mm';
        $('volume-summary').textContent = (r.volume / 1000).toFixed(2) + ' cm³';
        const mass = r.volume / 1000 * DENSITY[state.material];
        $('mass-summary').textContent = (mass >= 1000 ? (mass / 1000).toFixed(2) + ' kg' : mass.toFixed(1) + ' g');

        const yes = (ok, a, b) => `<span class="${ok ? 'good' : 'bad'}">${ok ? a : b}</span>`;
        $('report-grid').innerHTML = [
            ['Watertight (yopiq)', yes(r.watertight, 'Ha', "Yo'q")],
            ['Ochiq qirralar', yes(r.boundaryEdges === 0, '0', r.boundaryEdges)],
            ['Non-manifold qirralar', yes(r.nonManifoldEdges === 0, '0', r.nonManifoldEdges)],
            ['Teskari yo\'nalgan qirralar', yes(r.inconsistentEdges === 0, '0', r.inconsistentEdges)],
            ['Normallar', yes(!r.invertedNormals, 'Tashqariga', 'Ichkariga')],
            ['Hajm', (r.volume / 1000).toFixed(2) + ' cm³'],
            ['Sirt yuzasi', (r.area / 100).toFixed(1) + ' cm²'],
            ['Vazn (' + $$('.mat-btn.active')[0].textContent.trim() + ')', $('mass-summary').textContent]
        ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

        if (r.watertight && !r.invertedNormals) setStatus('ok', '3D printga tayyor (watertight)');
        else setStatus('warn', 'Model yopiq emas — avto-tuzatishni bosing');
    }

    // ------------------------------------------------------------- UI helpers

    function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

    function setStatus(kind, text) {
        $('status-pill').className = 'status-pill ' + (kind === 'error' ? 'status-error' : kind === 'warn' ? 'status-warn' : '');
        $('status-text').textContent = text;
    }

    function renderMessages(el, items) {
        el.innerHTML = '';
        for (const [kind, text] of items) {
            const d = document.createElement('div');
            d.className = 'msg msg-' + kind;
            d.textContent = text;
            el.appendChild(d);
        }
    }

    let toastTimer;
    function toast(text, isError) {
        const t = $('toast');
        t.textContent = text;
        t.className = 'toast show' + (isError ? ' error' : '');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { t.className = 'toast'; }, 3500);
    }

    function busy(on, text) {
        $('loading-overlay').classList.toggle('active', on);
        if (text) $('loading-step-text').textContent = text;
    }

    function selectPreset(type, fit) {
        state.preset = type;
        $$('.btn-chip').forEach(b => b.classList.toggle('active', b.dataset.type === type));
        const meta = G.PRESETS[type];
        $('dims-form').classList.toggle('hidden', type === 'drawing');
        if (type === 'drawing') renderMessages($('validation-messages'), [['ok', "O'lchamlar chizmadan olingan. Parametrik shaklga qaytish uchun boshqa shaklni tanlang."]]);
        $('param-group').classList.toggle('hidden', !meta.param);
        if (meta.param) $('label-param').textContent = meta.param;
        const revolve = meta.revolve || (type === 'contour' && state.contour && state.contour.mode === 'revolve');
        $('label-length').textContent = revolve ? 'Diametr (D)' : 'Uzunlik (L)';
        $('dim-width').readOnly = !!revolve;
        $('label-width').textContent = revolve ? 'Chuqurlik (= D)' : (type === 'contour' ? 'Qalinlik (W)' : 'Chuqurlik (W)');
        if (revolve) $('dim-width').value = $('dim-length').value;
        rebuild({ fit });
    }

    function applyPresetDims(type) {
        const d = PRESET_DIMS[type];
        if (!d) return;
        ['dim-length', 'dim-width', 'dim-height', 'dim-param'].forEach((id, i) => { $(id).value = d[i]; });
    }

    function download(data, filename, type) {
        const blob = data instanceof Blob ? data : new Blob([data], { type });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }

    // ---------------------------------------------------------- image → contour

    async function loadMedia(file) {
        busy(true, 'Rasm tahlil qilinmoqda...');
        try {
            const source = file.type.startsWith('video/') ? await videoFrame(file) : await loadImage(file);
            const max = 320;
            const k = Math.min(1, max / Math.max(source.width, source.height));
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(source.width * k));
            c.height = Math.max(1, Math.round(source.height * k));
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(source.el, 0, 0, c.width, c.height);
            state.contourSource = ctx.getImageData(0, 0, c.width, c.height);
            $('media-preview-container').innerHTML = '';
            const thumb = document.createElement('div');
            thumb.className = 'media-thumb';
            const img = document.createElement('img');
            img.src = c.toDataURL('image/jpeg', 0.8);
            img.alt = file.name;
            thumb.appendChild(img);
            $('media-preview-container').appendChild(thumb);
            runContour(true);
        } catch (err) {
            console.error(err);
            toast('Faylni o\'qib bo\'lmadi: ' + err.message, true);
        } finally {
            busy(false);
        }
    }

    function loadImage(file) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve({ el: img, width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = () => reject(new Error('rasm formati qo\'llab-quvvatlanmaydi'));
            img.src = URL.createObjectURL(file);
        });
    }

    function videoFrame(file) {
        return new Promise((resolve, reject) => {
            const v = document.createElement('video');
            v.muted = true; v.playsInline = true; v.preload = 'auto';
            v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 0) / 2); };
            v.onseeked = () => resolve({ el: v, width: v.videoWidth, height: v.videoHeight });
            v.onerror = () => reject(new Error('video formati qo\'llab-quvvatlanmaydi'));
            v.src = URL.createObjectURL(file);
        });
    }

    function runContour(isNew) {
        if (!state.contourSource) return;
        const threshold = +$('contour-threshold').value;
        $('threshold-value').textContent = threshold;
        const result = G.extractContour(state.contourSource, { threshold });
        drawContourPreview(result);
        $('contour-panel').classList.remove('hidden');
        const chip = $$('.btn-chip[data-type="contour"]')[0];
        if (!result) {
            state.contour = null;
            chip.disabled = true;
            $('contour-hint').textContent = 'Obyekt fondan ajratilmadi. Sezgirlikni o\'zgartiring yoki bir xil rangli fonda suratga oling.';
            if (state.preset === 'contour') selectPreset('spray_bottle', true);
            return;
        }
        result.mode = $('contour-mode').value;
        state.contour = result;
        chip.disabled = false;
        chip.title = '';
        const { bbox } = result;
        const aspect = (bbox.maxX - bbox.minX) / (bbox.maxY - bbox.minY);
        const H = parseFloat($('dim-height').value) || 100;
        if (isNew) $('dim-length').value = (Math.round(H * aspect * 10) / 10);
        $('contour-hint').textContent = 'Kalibrovka: H (balandlik) va L ni real o\'lchamga to\'g\'rilang — model shunga moslab masshtablanadi.';
        selectPreset('contour', isNew);
    }

    function drawContourPreview(result) {
        const src = state.contourSource;
        const c = $('contour-preview');
        const ctx = c.getContext('2d');
        const k = Math.min(c.width / src.width, c.height / src.height);
        const w = Math.round(src.width * k), h = Math.round(src.height * k);
        const tmp = document.createElement('canvas');
        tmp.width = src.width; tmp.height = src.height;
        const tctx = tmp.getContext('2d');
        const out = tctx.createImageData(src.width, src.height);
        for (let p = 0; p < src.width * src.height; p++) {
            const i = p * 4;
            const on = result && result.mask[p];
            out.data[i] = on ? 0 : src.data[i] * 0.35;
            out.data[i + 1] = on ? 242 : src.data[i + 1] * 0.35;
            out.data[i + 2] = on ? 254 : src.data[i + 2] * 0.35;
            out.data[i + 3] = 255;
        }
        tctx.putImageData(out, 0, 0);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(tmp, (c.width - w) / 2, (c.height - h) / 2, w, h);
    }

    // ---------------------------------------------------------- STL import

    async function importSTL(file) {
        busy(true, 'STL o\'qilmoqda...');
        try {
            const soup = G.parseSTL(await file.arrayBuffer());
            showSoup(soup, file.name.replace(/\.stl$/i, ''));
            state.spec = null;
            $$('.btn-chip').forEach(b => b.classList.remove('active'));
            renderMessages($('validation-messages'), [['warn', 'Import qilingan STL ko\'rsatilmoqda. Parametrik modelga qaytish uchun shaklni tanlang.']]);
            renderMessages($('repair-messages'), []);
            fitCamera();
        } catch (err) {
            toast(err.message, true);
        } finally {
            busy(false);
        }
    }

    function showSoup(soup, name) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(soup, 3));
        geo.computeVertexNormals();
        state.soup = soup;
        if (name) state.modelName = name;
        setGeometry(geo);
        analyze();
    }

    function repair() {
        if (!state.soup) return;
        const { positions, log } = G.repairMesh(state.soup);
        showSoup(positions);
        const r = state.report;
        const extra = [];
        if (r.nonManifoldEdges) extra.push(['error', `${r.nonManifoldEdges} ta non-manifold qirra avtomatik tuzatilmaydi — modelni CAD dasturida tekshiring.`]);
        else if (!r.watertight) extra.push(['error', `${r.boundaryEdges} ta ochiq qirra qoldi — teshik avtomatik yopilmadi.`]);
        renderMessages($('repair-messages'), log.map(l => [r.watertight ? 'ok' : 'warn', l]).concat(extra));
    }

    // --------------------------------------------------------------- server

    async function detectApi() {
        const param = new URLSearchParams(location.search).get('api');
        const candidates = param ? [param] : (location.protocol.startsWith('http') ? [location.origin] : []);
        for (const base of candidates) {
            try {
                const res = await fetch(base.replace(/\/$/, '') + '/api/health', { cache: 'no-store' });
                if (res.ok) {
                    const info = await res.json();
                    state.api = { base: base.replace(/\/$/, ''), step: !!info.step, drawing: !!info.drawing };
                    break;
                }
            } catch (e) { /* not available */ }
        }
        const status = $('server-status');
        if (!state.api) status.textContent = 'Server ulanmagan: STEP eksport va server tekshiruvi uchun `python backend/main.py` ni ishga tushirib, ilovani http://localhost:8000 orqali oching.';
        else if (!state.api.step) status.textContent = 'Server ulangan, lekin CadQuery o\'rnatilmagan — STEP eksport mavjud emas (pip install cadquery).';
        else status.textContent = 'Server ulangan: STEP eksport (CadQuery) va trimesh tekshiruvi tayyor.';
        $('export-step').classList.toggle('disabled', !(state.api && state.api.step));
        $('btn-server-check').disabled = !state.api;
        const drawingReady = !!(state.api && state.api.drawing);
        $('btn-analyze-drawing').disabled = !(drawingReady && state.drawingFile);
        $('drawing-status').textContent = !state.api
            ? "Chizma tahlili uchun server kerak: ANTHROPIC_API_KEY bilan `python backend/main.py` ni ishga tushiring."
            : drawingReady ? "Chizma Claude'ga (Anthropic API) yuboriladi va tahlil qilinadi."
            : "Serverda ANTHROPIC_API_KEY o'rnatilmagan — chizma tahlili o'chirilgan.";
    }

    // ------------------------------------------------------- drawing → 3D

    function pickDrawing(file) {
        if (!file) return;
        const ok = /^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.type === 'application/pdf';
        if (!ok) { toast('Faqat PNG, JPEG, WEBP, GIF yoki PDF chizma', true); return; }
        state.drawingFile = file;
        $('drawing-file-name').textContent = '📄 ' + file.name + ' (' + Math.round(file.size / 1024) + ' KB)';
        $('btn-analyze-drawing').disabled = !(state.api && state.api.drawing);
    }

    async function analyzeDrawing() {
        if (!state.drawingFile || !state.api || !state.api.drawing) return;
        busy(true, 'Chizma tahlil qilinmoqda... (bir necha daqiqa olishi mumkin)');
        try {
            const note = $('drawing-note').value.trim();
            const res = await fetch(state.api.base + '/api/drawing/analyze?note=' + encodeURIComponent(note), {
                method: 'POST', headers: { 'Content-Type': state.drawingFile.type }, body: state.drawingFile
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || res.statusText);
            useDrawing(data, []);
        } catch (err) {
            console.error(err);
            toast('Chizma tahlili: ' + err.message, true);
        } finally {
            busy(false);
        }
    }

    function useDrawing(data, warnings) {
        state.drawing = data;
        renderDrawingResult(data.analysis);
        renderMessages($('drawing-messages'), (warnings || []).map(w => ['warn', w]));
        $$('.btn-chip[data-type="drawing"]')[0].classList.remove('hidden');
        selectPreset('drawing', true);
        if (state.report && !state.report.watertight) toast("Model yopiq chiqmadi — Claude'dan geometriyani qayta tekshirishni so'rang", true);
        else toast('3D model chizma asosida yaratildi');
    }

    async function copyPrompt() {
        const text = D.buildPrompt($('drawing-note').value);
        try {
            await navigator.clipboard.writeText(text);
            toast("Prompt nusxalandi — endi claude.ai'da chizma bilan birga yuboring");
        } catch (e) {
            // clipboard blocked (http, old browser): show the text so it can be copied by hand
            const fb = $('prompt-fallback');
            fb.value = text;
            fb.classList.remove('hidden');
            fb.classList.add('note-input');
            fb.rows = 6;
            fb.focus();
            fb.select();
            toast("Avtomatik nusxalab bo'lmadi — belgilangan matnni Ctrl+C bilan nusxalang", true);
        }
    }

    function buildFromAnswer() {
        try {
            const { spec, analysis, warnings } = D.parseAnswer($('drawing-answer').value);
            useDrawing({ spec, analysis }, warnings);
        } catch (err) {
            renderMessages($('drawing-messages'), [['error', err.message]]);
        }
    }

    function setDrawingMode(mode) {
        $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
        $('drawing-free').classList.toggle('hidden', mode !== 'free');
        $('drawing-api').classList.toggle('hidden', mode !== 'api');
    }

    function renderDrawingResult(a) {
        const el = $('drawing-result');
        const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const conf = { high: 'yuqori', medium: "o'rtacha", low: 'past' }[a.confidence] || a.confidence;
        el.innerHTML =
            `<div><strong>${esc(a.part_name || 'Detal')}</strong> · ${a.kind === 'revolve' ? 'aylanma jism' : 'plastina'} · ishonch: <span class="conf-${esc(a.confidence)}">${esc(conf)}</span></div>` +
            (a.dimensions && a.dimensions.length ? `<div><h4>O'qilgan o'lchamlar</h4><ul>${a.dimensions.map(d => `<li>${esc(d.label)}: ${esc(d.value_mm)} mm</li>`).join('')}</ul></div>` : '') +
            (a.assumptions && a.assumptions.length ? `<div><h4>Taxminlar va soddalashtirishlar</h4><ul>${a.assumptions.map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>` : '');
        el.classList.remove('hidden');
    }

    async function serverCheck() {
        if (!state.api || !state.soup) return;
        busy(true, 'Serverda tekshirilmoqda (trimesh)...');
        try {
            const res = await fetch(state.api.base + '/api/mesh/check', {
                method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
                body: G.toBinarySTL(state.soup, state.modelName)
            });
            if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
            const r = await res.json();
            renderMessages($('repair-messages'), [
                [r.watertight ? 'ok' : 'warn', `Server (trimesh): watertight = ${r.watertight ? 'ha' : 'yo\'q'}, winding = ${r.winding_consistent ? 'mos' : 'mos emas'}, ${r.triangles} uchburchak`],
                ['ok', `Hajm ${r.volume_cm3 != null ? r.volume_cm3.toFixed(2) + ' cm³' : '—'}, o'lcham ${r.extents.map(v => v.toFixed(1)).join(' × ')} mm`]
            ]);
        } catch (err) {
            toast('Server xatosi: ' + err.message, true);
        } finally {
            busy(false);
        }
    }

    // --------------------------------------------------------------- export

    async function exportModel(format) {
        if (!state.soup) return;
        const base = `AI-CAD_${state.modelName}_${Date.now()}`;
        try {
            if (format === 'stl' || format === 'obj') {
                const { positions, report } = G.repairMesh(state.soup);
                if (format === 'stl') download(G.toBinarySTL(positions, state.modelName), base + '.stl', 'model/stl');
                else download(G.toOBJ(positions, state.modelName), base + '.obj', 'text/plain');
                toast(`${format.toUpperCase()} yuklab olindi · ${report.triangles.toLocaleString()} uchburchak · ${report.watertight ? 'watertight' : 'yopiq emas!'}`, !report.watertight);
            } else if (format === 'glb') {
                const clone = new THREE.Mesh(mesh.geometry, new THREE.MeshStandardMaterial(MATERIALS[state.material]));
                clone.scale.setScalar(0.001);   // glTF units are metres
                new THREE.GLTFExporter().parse(clone, glb => {
                    download(new Blob([glb], { type: 'model/gltf-binary' }), base + '.glb');
                    toast('GLB yuklab olindi');
                }, { binary: true });
            } else if (format === 'step') {
                if (!state.api || !state.api.step) { toast($('server-status').textContent, true); return; }
                if (!state.spec) { toast('STEP faqat parametrik modellar uchun — import qilingan STL dan STEP yasab bo\'lmaydi.', true); return; }
                busy(true, 'CadQuery bilan STEP solid yaratilmoqda...');
                const res = await fetch(state.api.base + '/api/export/step', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(Object.assign({ name: state.modelName }, state.spec))
                });
                if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
                download(await res.blob(), base + '.step');
                toast('STEP yuklab olindi (B-rep solid)');
            }
            $('export-modal').classList.remove('active');
        } catch (err) {
            console.error(err);
            toast('Eksport xatosi: ' + err.message, true);
        } finally {
            busy(false);
        }
    }

    // -------------------------------------------------------------- wiring

    function bindEvents() {
        let timer;
        ['dim-length', 'dim-width', 'dim-height', 'dim-param'].forEach(id => {
            $(id).addEventListener('input', () => {
                clearTimeout(timer);
                timer = setTimeout(() => rebuild(), 120);
            });
        });

        $$('.btn-chip').forEach(b => b.addEventListener('click', () => {
            if (b.disabled) return;
            applyPresetDims(b.dataset.type);
            selectPreset(b.dataset.type, true);
        }));

        $$('.mat-btn').forEach(b => b.addEventListener('click', () => {
            $$('.mat-btn').forEach(x => x.classList.toggle('active', x === b));
            state.material = b.dataset.material;
            if (mesh) { mesh.material.dispose(); mesh.material = makeMaterial(); }
            analyze();
        }));

        const toggle = (id, key, fn) => $(id).addEventListener('click', e => {
            state[key] = !state[key];
            e.currentTarget.classList.toggle('active', state[key]);
            fn();
        });
        toggle('btn-toggle-wireframe', 'wireframe', () => { if (mesh) mesh.material.wireframe = state.wireframe; });
        toggle('btn-toggle-grid', 'grid', () => { if (gridHelper) gridHelper.visible = state.grid; });
        toggle('btn-toggle-dims', 'dims', () => { if (dimsGroup) dimsGroup.visible = state.dims; });
        toggle('btn-toggle-section', 'section', updateSection);
        toggle('btn-toggle-rotate', 'rotate', () => {});
        $('section-axis').addEventListener('change', updateSection);
        $('section-pos').addEventListener('input', updateSection);
        $('btn-reset-view').addEventListener('click', fitCamera);

        // media upload
        const zone = $('upload-zone'), input = $('file-input');
        $('btn-pick-file').addEventListener('click', e => { e.stopPropagation(); input.click(); });
        zone.addEventListener('click', () => input.click());
        input.addEventListener('change', () => { if (input.files[0]) loadMedia(input.files[0]); input.value = ''; });
        zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
        zone.addEventListener('drop', e => {
            e.preventDefault();
            zone.classList.remove('dragover');
            const f = e.dataTransfer.files[0];
            if (!f) return;
            if (/\.stl$/i.test(f.name)) importSTL(f); else loadMedia(f);
        });
        let ctimer;
        $('contour-threshold').addEventListener('input', () => { clearTimeout(ctimer); ctimer = setTimeout(() => runContour(false), 80); });
        $('contour-mode').addEventListener('change', () => {
            if (state.contour) { state.contour.mode = $('contour-mode').value; selectPreset('contour', true); }
        });

        // STL import
        $('btn-import-stl').addEventListener('click', () => $('stl-input').click());
        $('stl-input').addEventListener('change', e => { if (e.target.files[0]) importSTL(e.target.files[0]); e.target.value = ''; });

        $('btn-repair').addEventListener('click', repair);

        const dz = $('drawing-zone'), di = $('drawing-input');
        dz.addEventListener('click', () => di.click());
        di.addEventListener('change', () => { pickDrawing(di.files[0]); di.value = ''; });
        dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
        dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
        dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('dragover'); pickDrawing(e.dataTransfer.files[0]); });
        $('btn-analyze-drawing').addEventListener('click', analyzeDrawing);
        $('btn-copy-prompt').addEventListener('click', copyPrompt);
        $('btn-build-answer').addEventListener('click', buildFromAnswer);
        $$('.tab').forEach(t => t.addEventListener('click', () => setDrawingMode(t.dataset.mode)));
        $('btn-server-check').addEventListener('click', serverCheck);

        $('btn-example-load').addEventListener('click', () => {
            applyPresetDims('spray_bottle');
            selectPreset('spray_bottle', true);
        });

        $('btn-export-modal').addEventListener('click', () => $('export-modal').classList.add('active'));
        $('btn-close-export').addEventListener('click', () => $('export-modal').classList.remove('active'));
        $('export-modal').addEventListener('click', e => { if (e.target.id === 'export-modal') e.target.classList.remove('active'); });
        $$('.export-card').forEach(c => c.addEventListener('click', () => exportModel(c.dataset.format)));
        document.addEventListener('keydown', e => { if (e.key === 'Escape') $('export-modal').classList.remove('active'); });
    }

    document.addEventListener('DOMContentLoaded', () => {
        initViewer();
        bindEvents();
        applyPresetDims('spray_bottle');
        selectPreset('spray_bottle', true);
        detectApi();
    });

    // exposed for debugging and automated browser tests
    window.AICad = { state, exportModel, repair, importSTL, loadMedia, rebuild, selectPreset, showSpec };
})();
