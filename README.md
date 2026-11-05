# AI-CAD 3D

Rasm, video va real o'lchamlardan 3D printga tayyor (watertight) va CAD uchun model yasaydigan veb-ilova.

## Imkoniyatlar

- **Parametrik shakllar:** sprey/ballon, quti (yumaloq burchakli), flanes (markaziy teshikli), vtulka/quvur.
- **Texnik chizmadan 3D (AI), uch usulda:**
  - **Gemini (avtomatik, bepul):** aistudio.google.com/apikey saytidan olingan bepul Gemini API kalitini saytga kiritasiz va chizmani yuklaysiz, model o'zi chiqadi. Kalit faqat sizning brauzeringizda saqlanadi va faqat Google'ga yuboriladi. Bepul tarifda kunlik limit bor.
  - **Qo'lda (chat, bepul):** gemini.google.com yoki claude.ai orqali. sayt tayyor prompt beradi. Chizmani shu prompt bilan claude.ai'ga yuklaysiz, Claude qaytargan JSON'ni saytga qo'yasiz va model yasaladi. API kalit ham, server ham kerak emas, GitHub Pages'da ham ishlaydi.
  - **Avtomatik (API):** chizma serverdan to'g'ridan-to'g'ri Claude API'ga (`claude-opus-5-5`) yuboriladi. Serverda `ANTHROPIC_API_KEY` bo'lishi kerak, har bir tahlil pullik.
  - Detal qismlardan yig'iladi: prizma (istalgan kontur), silindr, muntazam ko'pburchak (olti qirra, kvadrat), aylanalar qobig'i (kalit dastasi, quloqcha) va aylanma jism. Ular X, Y yoki Z o'qi bo'ylab qo'shiladi yoki kesib olinadi. Shu tariqa ariqlar, qiya kesimlar, olti qirrali va kvadrat teshiklar yasaladi. Brauzerda [Manifold](https://github.com/elalish/manifold) kutubxonasi ishlaydi va natija har doim yopiq (watertight) chiqadi. STEP fayl CadQuery'da xuddi shu qismlardan aniq yasaladi.
  - `tests/fixtures/drawings.json` faylida uchta haqiqiy chizmaning modeli bor (silindrli blok, gayka kaliti, vtulkali asos). Ularning hajmi qo'lda hisoblangan qiymat bilan solishtiriladi. Javob tekshiriladi: o'zini kesib o'tgan kontur yoki kontur tashqarisidagi teshik bo'lsa, ogohlantirish chiqadi. O'qilgan o'lchamlar va qilingan taxminlar ekranda ko'rsatiladi.
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
export ANTHROPIC_API_KEY=sk-ant-...   # chizma tahlili uchun (ixtiyoriy)
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
| `js/csg.js` | qismlardan yig'iladigan detal ("csg" spec) → Manifold |
| `js/gemini.js` | Gemini API mijozi (brauzerda, foydalanuvchi kaliti bilan) |
| `js/drawing.js` | bepul usul: prompt, Claude javobini o'qish va tekshirish |
| `backend/drawing.py` | chizma → Claude vision (structured output) → spec |
| `backend/mesh.py` | trimesh tekshiruvi va tuzatish |
| `backend/main.py` | FastAPI server |

Model "spec" sifatida tasvirlanadi (`revolve` profil yoki `extrude` kontur). Bitta spec'dan brauzer meshi ham, STEP solid ham yasaladi, shuning uchun ikkalasining o'lchamlari bir xil chiqadi.
