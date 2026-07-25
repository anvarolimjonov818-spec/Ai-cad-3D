# TEXNIK TOPSHIRIQ (Technical Task / Software Requirements Specification)

## Loyiha Nomi: **AI-CAD 3D Scan & Reconstructor**
**Hujjat Versiyasi:** 1.0.0  
**Sana:** 25-Iyul, 2026-yil  
**Maqsadi:** Telefon kamerasidan olingan foto/video hamda kiritilgan o'lchamlar asosida aniq, 3D Print va CNC stanoklarida ishlatishga tayyor bo'lgan 3D (STL, STEP, OBJ, GLTF) modellashtirish tizimini yaratish.

---

## 1. LOYIHA UMUMIY MAQSADI VA QAMROVI

Ushbu tizim fizik obyektlar (zapchastlar, kronshteynlar, flaneslar, korpuslar va plastik detallar) fotosuratlari yoki videolarini qayta ishlab, ularning **muhandislik standartlariga javob beradigan parametrik 3D modelini (CAD)** avtomatik yaratish uchun mo'ljallangan.

### Asosiy Qo'llanilish Sohalari:
- **Revers-injoniring (Reverse Engineering):** Buzilgan yoki nusxasi yo'q ehtiyot qismlarni qayta tiklash.
- **3D Bosib chiqarish (3D Printing):** Uyda va sanoatda STL fayllarni tayyorlash.
- **CNC va Metalloobrabotka:** SolidWorks va AutoCAD uchun STEP/IGES formatidagi modellarni olish.

---

## 2. TIZIM ARXITEKTURASI VA TEXNOLOGIK STEK

```mermaid
graph TD
    Client[📱 Mobile App / Web UI (React Native / Flutter / Next.js)] -->|HTTPS / WebSockets| Gateway[API Gateway (FastAPI / Go)]
    Gateway --> Queue[Task Queue (Redis + Celery)]
    Queue --> AIEngine[🧠 AI Vision & Photogrammetry Service (Python + PyTorch)]
    Queue --> CADEngine[⚙️ Parametric CAD & Mesh Engine (OpenCASCADE + Trimesh)]
    AIEngine --> Storage[(Cloud Storage AWS S3 / MinIO)]
    CADEngine --> Storage
    Storage --> Client
```

| Qatlam | Texnologiyalar | Vazifasi |
|---|---|---|
| **Client Frontend** | Flutter / React Native, Three.js, WebGL | Skanerlash yo'riqnomasi, 3D ko'rish va o'lcham kiritish |
| **API Gateway** | Go (Gin) / Python (FastAPI) | Foydalanuvchilar, to'lovlar va so'rovlarni marshrutlash |
| **AI Vision Engine** | PyTorch, OpenCV, InstantMesh, NeRF, COLMAP | Ob'ekt silueti, chuqurlik xaritasi va 3D to'r (mesh) yaratish |
| **CAD Processing Engine** | OpenCASCADE (pythonocc), PyMesh, Trimesh | Burchaklarni tekislash, STEP/IGES parametrik fayllarini shakllantirish |
| **Database & Storage** | PostgreSQL, Redis, AWS S3 / MinIO | Metama'lumotlar, kesh va 3D fayllar saqlash joyi |

---

## 3. FUNKTSIONAL TALABLAR (Functional Requirements)

### FR-1: Smart Guided Capture (Aqlli Skanerlash)
* **FR-1.1:** Tizim telefon kamerasidan 360° video yoki kamida 3 ta (old, yon, top) burchakdan olingan suratlarni qabul qilishi shart.
* **FR-1.2:** Kamera interfeysi giroskop va AR (Augmented Reality) datchiklari orqali foydalanuvchiga *"Kamerani 30° pasaytiring"*, *"Yorug'lik yetarsiz"* kabi real-vaqt ko'rsatmalarini berishi shart.
* **FR-1.3:** Tasvirdagi xiralik (blur) va fokus buzilishini avtomatik aniqlab, yomon kadrlarni rad etishi kerak.

### FR-2: O'lcham Kiritish va Kalibrovka (Calibration Engine)
* **FR-2.1 (Manual Mode):** Foydalanuvchi detalning kamida 1 ta (Uzunlik, Kenglik, Balandlik yoki Teshik Diametri) o'lchamini millimetrda (mm) kiritish imkoniyatiga ega bo'lishi kerak.
* **FR-2.2 (Auto Marker Mode):** Ob'ekt yonida ma'lum o'lchamli etalon (tanga, chizg'ich, kredit karta yoki ArUco marker) bo'lsa, AI piksel nisbatini avtomatik hisoblab kalibrovka qilishi kerak.
* **FR-2.3 (LiDAR / Depth Sensor):** LiDAR datchikli qurilmalarda (iPhone Pro / Android ToF) masofani datchik orqali avto-aniqlashi shart.

### FR-3: AI Mesh Reconstruction & Occlusion Infilling
* **FR-3.1:** Kiruvchi tasvirlar va o'lchamlar asosida 3D Poligonal Mesh (Point Cloud va Triangle Mesh) hosil qilinishi kerak.
* **FR-3.2 (Occlusion Infilling):** Foto tushmagan orqa yoki pastki qism yuzalarini simmetriya va AI generative algoritmlar orqali avtomatik to'ldirish shart.

### FR-4: Parametric CAD Snapping (Geometric Regularization)
* **FR-4.1 (Surface Fitting):** Shovqinli va g'adir-budur poligon yuzalarni tekis tekisliklarga (Planes), to'g'ri silindrlarga (Cylinders) va sferalarga (Spheres) tekislashi kerak.
* **FR-4.2 (Orthogonality & Parallelism):** Yon bag'irlari 90° yoki 45° ga yaqin burchaklarni aniq 90.0° va 45.0° ga standartlashtirishi shart.
* **FR-4.3 (Hole Detection):** Teshiklarni to'g'ri doira shakliga keltirishi hamda ularning markazlarini detal o'qiga moslashi shart.

### FR-5: 3D Print Readiness (Watertight Check & Auto-Repair)
* **FR-5.1:** Modelda teshiklar (open boundaries), ichki yopiq bo'lmagan yuzalar (*non-manifold edges*) va teskari normallar bo'lmasligi shart.
* **FR-5.2:** Tizim STL faylni eksport qilishdan oldin "Watertight Verification" auditini o'tkazib, xatolik bo'lsa avtomatik tuzatishi shart.

### FR-6: Interaktiv 3D Viewer & Manual Modeler
* **FR-6.1:** WebGL va Three.js bazasida ishlaydigan interaktiv 3D vizualizator:
  * 360° Panorama va Orbit Controls.
  * Wireframe (Karkas) va Solid rejimlar.
  * O'lcham chizgichlari (3D Measurement Annotations).
  * Kesim ko'rinishi (Section Clipping View).
  * Materiallar (Metall, Plastik, Alyuminiy) simulyatsiyasi.

### FR-7: Eksport va Integratsiya
* **STL:** 3D Printing (Cura, PrusaSlicer).
* **STEP / IGES:** CAD dasturlari (SolidWorks, Fusion 360, AutoCAD, Catia).
* **OBJ / GLTF:** Veb va AR ilovalari.

---

## 4. XATOLIKLAR VA BAGLARNI OLDINI OLISH STRATEGIYASI (Edge Cases & Fault Tolerance)

| # | Mumkin bo'lgan muammo/bag | Sababi | Algoritmik va Mantiqiy Yechim |
|---|---|---|---|
| **1** | **Yaltiroq / Aks etuvchi metall yuzalar** | Metalldagi akslar fotogrammetriyada noto'g'ri nuqtalar beradi | AI polarizatsiya va **Specular Highlight Suppression** filtri qo'llaniladi. Ob'ekt mat konturidan karkas olinadi. |
| **2** | **Noto'g'ri / Mantiqsiz o'lcham kiritilishi** | Foydalanuvchi uzunlikni 100mm, teshikni esa 150mm deb kiritishi | **Input Validation Engine:** Teshik diametri > Ob'ekt o'lchami bo'lsa, tizim *"Teshik o mezonlari ob'ekt o'lchamiga mos emas"* ogohlantirishini beradi. |
| **3** | **Brauzer yoki Telefon Xotirasini To'lib Qolishi (Out of Memory)** | Yuqori poligonli (1M+ tris) 3D fayllar render bo'lganda | **LOD (Level of Detail) & WebGL Buffer Management:** Vokzal visualizer uchun poligonlar soni avtomatik 50,000 tris ga kamaytiriladi (Decimation). Yuklash uchun esa original fayl beriladi. |
| **4** | **Serverda AI Qayta Ishlash Vakanti Uzoq Kutilishi** | Navbat ko'payishi | Redis + Celery asosida **Asinxron navbat (Async Queue)** va WebSocket orqali progress bar holatini real-vaqtda ko'rsatish. |
| **5** | **Nol qalinlikdagi devorlar (Zero-thickness Geometry)** | 3D printerda chop etib bo'lmaslik | Minimum devor qalinligi (Wall thickness check) kamida 1.2mm ekanligi avto-tahlil qilinadi va yetmasa qalinlashtiriladi. |

---

## 5. NOFUNKTSIONAL TALABLAR (Non-Functional Requirements)

* **Tezkorlik (Performance):** Foto yuborilgandan so'ng 3D model shakllanishi maksimal **15-30 soniya** ichida yakunlanishi kerak.
* **Aniqlik (Accuracy Margin):** Kiritilgan etalon o'lchamga nisbatan modelning o'lcham xatoligi **±0.2 mm dan oshmasligi** shart.
* **Xavfsizlik (Security):** Yuklangan barcha foto va model fayllari HTTPS / TLS 1.3 orqali shifrlanadi. Foydalanuvchi fayllari 30 kundan keyin serverdan avtomatik o'chiriladi.
* **Kross-Platformadorlik:** iOS (Safari / App), Android (Chrome / App) va Desktop brauzerlarida 100% bir xil va uzluksiz ishlashi kerak.

---

## 6. SIFAT NAZORATI VA TESTLASH (QA & Verification Plan)

1. **Unit Testing:** CAD geometrik algoritmlari va surface-fitting tenglamalari uchun unit-testlar (Coverage > 90%).
2. **CAD Accuracy Benchmark:** 20 xil haqiqiy metall va plastik detal shtangensirkul bilan o'lchanadi hamda AI yaratgan STEP model bilan 3D-scan solishtirish (deviation map) o'tkaziladi.
3. **Stress & Load Testing:** Bir vaqtning o'zida 500 ta skanerlash so'rovi yuborilganda API va GPU resurslarining barqarorligi tekshiriladi.

---

### 📌 Xulosa
Ushbu Texnik Topshiriq loyihada yuzaga kelishi mumkin bo'lgan **barcha texnik, mantiqiy va arxitektura bo'shliqlarini (bugs/flaws) oldindan bartaraf etishga** mo'ljallangan. Dasturchilar jamoasi ushbu hujjat asosida darhol ishlab chiqishni boshlashi mumkin.
