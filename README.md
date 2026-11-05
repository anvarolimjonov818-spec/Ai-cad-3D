# AI-CAD 3D

Rasm, video va real o'lchamlardan 3D printga tayyor (watertight) va CAD uchun model yasaydigan veb-ilova.

## Imkoniyatlar

- **Parametrik shakllar:** sprey/ballon, quti (yumaloq burchakli), flanes (markaziy teshikli), vtulka/quvur.
- **Rasmdan kontur:** obyekt fondan brauzerning o'zida ajratiladi (fon rangi, eng katta bog'langan soha, ichki teshiklarni to'ldirish). Kontur aylantiriladi (idish, vtulka) yoki cho'ziladi (plastina, profil). Kalibrovka H va L orqali qilinadi. Videoda o'rtadagi kadr olinadi.
- **O'lcham tekshiruvi:** teshik detaldan katta bo'lsa yoki devor 1.2 mm dan yupqa bo'lsa, model yasalmaydi va xato ko'rsatiladi.
- **3D print tekshiruvi:** ochiq, non-manifold va teskari yo'nalgan qirralar soni, normallar yo'nalishi, hajm, sirt yuzasi va materialga qarab vazn.
- **Avto-tuzatish:** vertexlarni birlashtirish, degenerat va takroriy uchburchaklarni olib tashlash, winding'ni moslashtirish, teshiklarni yopish va normallarni tashqariga burish.
- **STL ochish:** mavjud STL faylni yuklab, tekshirish va tuzatish mumkin.
- **Viewer:** o'lcham chizgichlari, X/Y/Z bo'yicha kesim, karkas rejimi, setka, materiallar.
- **Eksport:**
  - STL: binary, mm, Z-up, eksportdan oldin tuzatiladi.
  - OBJ.
  - GLB: glTF, metrda.
  - STEP: serverda CadQuery bilan yasaladi, haqiqiy B-rep solid.

## Ishga tushirish

```bash
pip install -r backend/requirements.txt
python backend/main.py
```

So'ng brauzerda http://localhost:8000 ni oching.

`index.html` ni serversiz ham ochish mumkin. Bunda STEP eksport va server tekshiruvidan boshqa hamma narsa ishlaydi. Sahifa statik hostingda tursa, `?api=http://localhost:8000` parametri bilan backend'ga ulash mumkin.

## Testlar

```bash
npm install
npm test
```

- `tests/js/`: geometriya yadrosi (watertight, hajm, validatsiya, tuzatish, STL/OBJ, kontur).
- `tests/test_backend.py`: CadQuery solidlari brauzer meshiga mosligi (hajm va o'lcham), trimesh va API.

## Tuzilma

| Fayl | Vazifasi |
|---|---|
| `js/geometry.js` | DOM'siz geometriya yadrosi: spec, validatsiya, kontur, tahlil, tuzatish, STL/OBJ |
| `js/mesher.js` | spec → Three.js geometriya |
| `js/app.js` | UI, viewer, eksport |
| `backend/cad.py` | spec → CadQuery solid → STEP |
| `backend/mesh.py` | trimesh tekshiruvi va tuzatish |
| `backend/main.py` | FastAPI server |

Model "spec" sifatida tasvirlanadi (`revolve` profil yoki `extrude` kontur). Bitta spec'dan brauzer meshi ham, STEP solid ham yasaladi, shuning uchun ikkalasining o'lchamlari bir xil chiqadi.
