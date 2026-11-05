// Prints every preset's spec plus the browser mesh volume/size as JSON (used by test_backend.py).
const THREE = require('three');
const G = require('../../js/geometry.js');
const M = require('../../js/mesher.js');

const cases = [
    ['spray_bottle', { length: 60, width: 60, height: 180, param: 15 }],
    ['bevel_box', { length: 60, width: 50, height: 180, param: 6 }],
    ['flange', { length: 80, width: 60, height: 12, param: 20 }],
    ['tube', { length: 40, width: 40, height: 60, param: 30 }]
];
const out = cases.map(([preset, dims]) => {
    const spec = G.buildSpec(preset, dims);
    const geo = M.specToGeometry(THREE, spec);
    const r = G.analyzeMesh(geo.attributes.position.array);
    return { preset, spec, meshVolume: r.volume, meshSize: r.size };
});
process.stdout.write(JSON.stringify(out));
