/* =========================================================
   EARTH SPHERE (Three.js) — standalone module
   Depends on: THREE (global), window.WeatherHelpers (from app.js)
   Exposes:    window.EarthGlobe.{init, updateCurrentMarker, rotateGlobeTo,
                                  updateSavedMarkers, renderPanel, updateSaveButton}
========================================================= */
(function () {
    'use strict';

    /* ---------- Bridge to app.js helpers ---------- */
    function H() {
        return window.WeatherHelpers || {};
    }

    /* ---------- Globe state ---------- */
    let earthInitialized = false;
    let earthRenderer = null;
    let earthScene = null;
    let earthCamera = null;
    let earthMesh = null;
    let earthMaterial = null;
    const earthSunDirection = new THREE.Vector3(1, 0, 0);
    let currentLocationMarker = null;
    let savedLocationMarkers = [];

    let earthClouds = null;
    let cloudsVisible = true;
    let clockTimer = null;

    let earthStars = null;
    let starsVisible = true;
    let globeLockedOnCity = false;

    let camRadius = 3;
    let camPhi = Math.PI / 2;
    let camTheta = 0;
    let camTargetPhi = camPhi;
    let camTargetTheta = camTheta;
    let camAnimating = false;
    let autoRotatePausedUntil = 0;
    let globeInView = true;
    const AUTO_ROTATE_SPEED = 0.0025;
    const AUTO_ROTATE_PAUSE_MS = 15000;

    /* ---------- Geometry helpers ---------- */
    function latLonToVector3(lat, lon, radius = 1) {
        const phi = (90 - lat) * Math.PI / 180;
        const theta = (lon + 180) * Math.PI / 180;
        const x = -radius * Math.sin(phi) * Math.cos(theta);
        const y =  radius * Math.cos(phi);
        const z =  radius * Math.sin(phi) * Math.sin(theta);
        return new THREE.Vector3(x, y, z);
    }

    function vector3ToLatLon(v) {
        const r = v.length();
        const lat = 90 - Math.acos(v.y / r) * 180 / Math.PI;
        let lon = (Math.atan2(v.z, -v.x) * 180 / Math.PI) - 180;
        lon = ((lon + 540) % 360) - 180;
        return { lat, lon };
    }

    function getSunDirection() {
        const now = new Date();
        const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
        const subsolarLon = -15 * (utcHours - 12);

        const start = new Date(now.getUTCFullYear(), 0, 1);
        const dayOfYear = Math.floor((now - start) / 86400000) + 1;
        const decl = 23.44 * Math.sin(2 * Math.PI * (dayOfYear - 81) / 365);

        return latLonToVector3(decl, subsolarLon, 1).normalize();
    }

    /* ---------- Markers ---------- */
    function removeMarker(marker) {
        if (!marker || !earthScene) return;
        earthScene.remove(marker);
        if (marker.geometry) marker.geometry.dispose();
        if (marker.material) marker.material.dispose();
    }

    function makeLabelSprite(text) {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        canvas.width = 256;
        canvas.height = 64;

        ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
        const r = 12;
        ctx.beginPath();
        ctx.moveTo(r, 0);
        ctx.lineTo(canvas.width - r, 0);
        ctx.quadraticCurveTo(canvas.width, 0, canvas.width, r);
        ctx.lineTo(canvas.width, canvas.height - r);
        ctx.quadraticCurveTo(canvas.width, canvas.height, canvas.width - r, canvas.height);
        ctx.lineTo(r, canvas.height);
        ctx.quadraticCurveTo(0, canvas.height, 0, canvas.height - r);
        ctx.lineTo(0, r);
        ctx.quadraticCurveTo(0, 0, r, 0);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = "rgba(56, 189, 248, 0.8)";
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.font = "bold 28px Arial, sans-serif";
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        const maxWidth = canvas.width - 20;
        let displayText = text;
        if (ctx.measureText(displayText).width > maxWidth) {
            while (displayText.length > 3 &&
                   ctx.measureText(displayText + "…").width > maxWidth) {
                displayText = displayText.slice(0, -1);
            }
            displayText += "…";
        }
        ctx.fillText(displayText, canvas.width / 2, canvas.height / 2);

        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearFilter;

        const material = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: true,
            depthWrite: false
        });

        const sprite = new THREE.Sprite(material);
        sprite.scale.set(0.28, 0.07, 1);
        return sprite;
    }

    function addMarker(lat, lon, color, size = 0.025, radius = 1.015) {
        const pos = latLonToVector3(lat, lon, radius);
        const geo = new THREE.SphereGeometry(size, 12, 12);
        const mat = new THREE.MeshBasicMaterial({ color });
        const dot = new THREE.Mesh(geo, mat);
        dot.position.copy(pos);
        return dot;
    }

    function updateCurrentMarker(lat, lon) {
        if (!earthScene) return;
        if (currentLocationMarker) {
            removeMarker(currentLocationMarker);
            currentLocationMarker = null;
        }
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

        const group = new THREE.Group();
        group.add(addMarker(lat, lon, 0xffffff, 0.03, 1.02));
        group.add(addMarker(lat, lon, 0xff3b3b, 0.02, 1.025));

        for (let i = 0; i < 2; i++) {
            const ringGeo = new THREE.RingGeometry(0.04, 0.05, 32);
            const ringMat = new THREE.MeshBasicMaterial({
                color: 0xff5c5c,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.75 - i * 0.3
            });
            const ring = new THREE.Mesh(ringGeo, ringMat);
            ring.position.copy(latLonToVector3(lat, lon, 1.03 + i * 0.005));
            ring.lookAt(0, 0, 0);
            ring.userData.pulseOffset = i * 0.5;
            group.add(ring);
        }

        earthScene.add(group);
        currentLocationMarker = group;
    }

    function updateSavedMarkers(savedLocations) {
        if (!earthScene) return;
        savedLocationMarkers.forEach(m => removeMarker(m));
        savedLocationMarkers = [];

        const list = Array.isArray(savedLocations) ? savedLocations : [];

        list.forEach(loc => {
            if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return;

            const marker = addMarker(loc.lat, loc.lon, 0x38bdf8, 0.018, 1.015);
            earthScene.add(marker);
            savedLocationMarkers.push(marker);

            const labelText = loc.name || "Unknown";
            const label = makeLabelSprite(labelText);
            const pos = latLonToVector3(loc.lat, loc.lon, 1.08);
            label.position.copy(pos);
            earthScene.add(label);
            savedLocationMarkers.push(label);
        });
    }

    /* ---------- Camera facing ---------- */
    function rotateGlobeTo(lat, lon) {
        if (!earthInitialized) return;
        camTargetPhi = (90 - lat) * Math.PI / 180;
        camTargetTheta = (lon + 180) * Math.PI / 180;

        let dTheta = camTargetTheta - camTheta;
        while (dTheta > Math.PI) { camTargetTheta -= 2 * Math.PI; dTheta = camTargetTheta - camTheta; }
        while (dTheta < -Math.PI) { camTargetTheta += 2 * Math.PI; dTheta = camTargetTheta - camTheta; }

        camAnimating = true;

        if (globeLockedOnCity) {
            autoRotatePausedUntil = Infinity;
        } else {
            autoRotatePausedUntil = Date.now() + AUTO_ROTATE_PAUSE_MS;
        }
    }

    /* ---------- Globe click ---------- */
    function onGlobeClick(event) {
        if (!earthRenderer || !earthMesh || !earthCamera) return;

        const rect = earthRenderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1
        );

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, earthCamera);

        const intersects = raycaster.intersectObject(earthMesh);
        if (!intersects.length) return;

        const point = intersects[0].point;
        const { lat, lon } = vector3ToLatLon(point);

        const roundedLat = Math.round(lat * 100) / 100;
        const roundedLon = Math.round(lon * 100) / 100;

        H().showToast(`📍 Loading weather at ${roundedLat}°, ${roundedLon}°`);

        H().getWeatherByLocation(roundedLat, roundedLon, `Point (${roundedLat}, ${roundedLon})`);
    }

    /* ---------- UTC clock caption ---------- */
    function startEarthClock() {
        if (clockTimer) return;

        function tick() {
            const el = H().getElement("earth-clock");
            if (!el) return;

            const now = new Date();
            const utcHours = String(now.getUTCHours()).padStart(2, "0");
            const utcMins  = String(now.getUTCMinutes()).padStart(2, "0");
            const utcSecs  = String(now.getUTCSeconds()).padStart(2, "0");

            el.textContent =
                `🕒 UTC ${utcHours}:${utcMins}:${utcSecs}  •  ` +
                `Drag to rotate · Scroll/pinch to zoom · Click to load weather`;
        }

        tick();
        clockTimer = setInterval(tick, 1000);
    }

    /* ---------- Earth info panel ---------- */
    function formatTimezoneLabel(offsetSeconds) {
        const totalMin = Math.round(Number(offsetSeconds) / 60);
        const sign = totalMin >= 0 ? "+" : "-";
        const abs = Math.abs(totalMin);
        const h = Math.floor(abs / 60);
        const m = abs % 60;
        return `UTC${sign}${h}${m > 0 ? ":" + String(m).padStart(2, "0") : ""}`;
    }

    function renderPanel(data) {
        if (!data) return;
        const w = H();

        const nameEl = w.getElement("ei-name");
        const coordsEl = w.getElement("ei-coords");
        const tzEl = w.getElement("ei-tz");
        const tempEl = w.getElement("ei-temp");
        const condEl = w.getElement("ei-condition");
        const sunriseEl = w.getElement("ei-sunrise");
        const sunsetEl = w.getElement("ei-sunset");

        const loc = data.searched_location || {};
        const cityName = loc.name || data.name || "Unknown";
        const state = loc.state || "";
        const country = loc.country || data.sys?.country || "";
        if (nameEl) nameEl.textContent = w.formatLocation(cityName, state, country);

        if (coordsEl) {
            const lat = data.coord?.lat;
            const lon = data.coord?.lon;
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
                const latDir = lat >= 0 ? "N" : "S";
                const lonDir = lon >= 0 ? "E" : "W";
                coordsEl.textContent =
                    `${Math.abs(lat).toFixed(2)}°${latDir}, ${Math.abs(lon).toFixed(2)}°${lonDir}`;
            } else {
                coordsEl.textContent = "--";
            }
        }

        if (tzEl) tzEl.textContent = formatTimezoneLabel(data.timezone || 0);

        const temp = Number(data.main?.temp);
        if (tempEl) tempEl.textContent = `${w.formatTemp(temp)}${w.tempUnit()}`;

        const ww = data.weather?.[0] || {};
        if (condEl) condEl.textContent = w.getConditionText(Number(ww.id), ww.description);

        const tz = Number(data.timezone || 0);
        if (sunriseEl) sunriseEl.textContent = w.formatTimeFromUnix(data.sys?.sunrise, tz);
        if (sunsetEl) sunsetEl.textContent = w.formatTimeFromUnix(data.sys?.sunset, tz);

        const btn = w.getElement("earth-save-btn");
        if (btn) {
            btn.onclick = () => {
                const saveBtn = w.getElement("save-location-btn");
                if (saveBtn) saveBtn.click();
                updateSaveButton();
            };
            updateSaveButton();
        }

        const shareBtn = w.getElement("earth-share-btn");
        if (shareBtn) {
            shareBtn.onclick = () => {
                if (typeof w.shareCurrentWeather === "function") {
                    w.shareCurrentWeather();
                }
            };
        }
    }

    function updateSaveButton() {
        const w = H();
        const btn = w.getElement("earth-save-btn");
        if (!btn) return;

        const loc = window._loadedLocation;
        if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) {
            btn.textContent = "♡ Save this place";
            btn.classList.remove("saved");
            return;
        }

        if (w.isLocationSaved(loc.lat, loc.lon)) {
            btn.textContent = "♥ Saved";
            btn.classList.add("saved");
        } else {
            btn.textContent = "♡ Save this place";
            btn.classList.remove("saved");
        }
    }

    /* ---------- Init ---------- */
    function initEarth() {
        if (earthInitialized) return;
        const w = H();

        const container = w.getElement("earth-container");
        if (!container) return;
        if (typeof THREE === "undefined") {
            console.warn("Three.js not loaded — Earth skipped");
            return;
        }

        const size = container.clientWidth || 320;

        earthScene = new THREE.Scene();

        earthCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
        earthCamera.position.set(camRadius, 0, 0);
        earthCamera.lookAt(0, 0, 0);

        earthRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        earthRenderer.setSize(size, size);
        earthRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        const canvas = earthRenderer.domElement;
        canvas.style.touchAction = "none";
        canvas.style.userSelect = "none";
        canvas.style.cursor = "grab";
        container.appendChild(canvas);

        const geometry = new THREE.SphereGeometry(1, 64, 64);

        const textureLoader = new THREE.TextureLoader();
        const earthTexture = textureLoader.load(
            "https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg",
            () => {
                const loader = w.getElement("earth-loader");
                if (loader) {
                    loader.classList.add("hidden");
                    setTimeout(() => loader.remove(), 600);
                }
            }
        );

        earthMaterial = new THREE.ShaderMaterial({
            uniforms: {
                earthMap: { value: earthTexture },
                sunDirection: { value: earthSunDirection }
            },
            vertexShader: `
                varying vec2 vUv;
                varying vec3 vWorldNormal;
                void main() {
                    vUv = uv;
                    vWorldNormal = normalize(mat3(modelMatrix) * normal);
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D earthMap;
                uniform vec3 sunDirection;
                varying vec2 vUv;
                varying vec3 vWorldNormal;
                void main() {
                    vec3 dayColor = texture2D(earthMap, vUv).rgb;
                    vec3 nightColor = dayColor * 0.12 + vec3(0.02, 0.05, 0.14);
                    float d = dot(normalize(vWorldNormal), normalize(sunDirection));
                    float mixAmount = smoothstep(-0.15, 0.15, d);
                    vec3 finalColor = mix(nightColor, dayColor, mixAmount);
                    gl_FragColor = vec4(finalColor, 1.0);
                }
            `
        });

        earthMesh = new THREE.Mesh(geometry, earthMaterial);
        earthScene.add(earthMesh);

        earthScene.add(new THREE.AmbientLight(0xffffff, 0.15));
        const sunLight = new THREE.DirectionalLight(0xffffff, 0.9);
        sunLight.position.set(5, 3, 5);
        earthScene.add(sunLight);

        const cloudTexture = textureLoader.load(
            "https://threejs.org/examples/textures/planets/earth_clouds_1024.png"
        );
        const cloudGeometry = new THREE.SphereGeometry(1.012, 64, 64);
        const cloudMaterial = new THREE.MeshLambertMaterial({
            map: cloudTexture,
            transparent: true,
            opacity: 0.55,
            depthWrite: false
        });
        earthClouds = new THREE.Mesh(cloudGeometry, cloudMaterial);
        earthClouds.visible = cloudsVisible;
        earthScene.add(earthClouds);

        const starGeo = new THREE.BufferGeometry();
        const starCount = 1500;
        const starPositions = new Float32Array(starCount * 3);
        for (let i = 0; i < starCount; i++) {
            const r = 30 + Math.random() * 20;
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos(2 * Math.random() - 1);
            starPositions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
            starPositions[i * 3 + 1] = r * Math.cos(phi);
            starPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
        }
        starGeo.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));

        const starMat = new THREE.PointsMaterial({
            color: 0xffffff,
            size: 0.35,
            sizeAttenuation: true,
            transparent: true,
            opacity: 0.9
        });
        earthStars = new THREE.Points(starGeo, starMat);
        earthStars.visible = starsVisible;
        earthScene.add(earthStars);

        const DRAG_SENSITIVITY = 0.006;
        const MIN_ZOOM = 1.5;
        const MAX_ZOOM = 5.0;

        let activePointers = new Map();
        let dragPointerId = null;
        let isDragging = false;
        let wasDragged = false;
        let lastX = 0, lastY = 0;
        let dragStartTime = 0;
        let pinchStartDist = 0;
        let pinchStartRadius = camRadius;

        function pauseAutoRotate(ms) {
            autoRotatePausedUntil = Date.now() + ms;
        }

        canvas.addEventListener("pointerdown", (e) => {
            canvas.setPointerCapture(e.pointerId);
            activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

            if (activePointers.size === 1) {
                isDragging = true;
                wasDragged = false;
                dragStartTime = Date.now();
                lastX = e.clientX;
                lastY = e.clientY;
                dragPointerId = e.pointerId;
                canvas.style.cursor = "grabbing";
                pauseAutoRotate(60000);
            } else if (activePointers.size === 2) {
                isDragging = false;
                const [p1, p2] = Array.from(activePointers.values());
                pinchStartDist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
                pinchStartRadius = camRadius;
            }
        });

        canvas.addEventListener("pointermove", (e) => {
            if (!activePointers.has(e.pointerId)) return;
            activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

            if (activePointers.size === 2) {
                const [p1, p2] = Array.from(activePointers.values());
                const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
                if (pinchStartDist > 0) {
                    const scale = pinchStartDist / dist;
                    camRadius = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinchStartRadius * scale));
                }
                return;
            }

            if (isDragging && e.pointerId === dragPointerId) {
                const dx = e.clientX - lastX;
                const dy = e.clientY - lastY;
                if (Math.abs(dx) + Math.abs(dy) > 3) wasDragged = true;
                lastX = e.clientX;
                lastY = e.clientY;

                camTheta += dx * DRAG_SENSITIVITY;
                camPhi   -= dy * DRAG_SENSITIVITY;
                camPhi = Math.max(0.15, Math.min(Math.PI - 0.15, camPhi));

                camAnimating = false;
                camTargetPhi = camPhi;
                camTargetTheta = camTheta;
            }
        });

        function endPointer(e) {
            activePointers.delete(e.pointerId);

            if (e.pointerId === dragPointerId) {
                const quickTap = !wasDragged && (Date.now() - dragStartTime < 400);
                isDragging = false;
                dragPointerId = null;
                canvas.style.cursor = "grab";

                if (quickTap) {
                    onGlobeClick(e);
                }
            }
        }
        canvas.addEventListener("pointerup", endPointer);
        canvas.addEventListener("pointercancel", endPointer);

        canvas.addEventListener("wheel", (e) => {
            e.preventDefault();
            camRadius += e.deltaY * 0.003;
            camRadius = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camRadius));
            pauseAutoRotate(10000);
        }, { passive: false });

        canvas.addEventListener("dblclick", () => {
            autoRotatePausedUntil = 0;
            camAnimating = false;
        });

        let lastSunUpdate = 0;

        function animate() {
            requestAnimationFrame(animate);

            if (!globeInView) return;

            const now = Date.now();

            if (now - lastSunUpdate > 30000) {
                earthSunDirection.copy(getSunDirection());
                lastSunUpdate = now;
            }

            if (now > autoRotatePausedUntil && !camAnimating && activePointers.size === 0) {
                camTheta += AUTO_ROTATE_SPEED;
            }

            if (camAnimating) {
                camPhi   += (camTargetPhi   - camPhi)   * 0.08;
                camTheta += (camTargetTheta - camTheta) * 0.08;
                if (Math.abs(camTargetPhi - camPhi) < 0.005 &&
                    Math.abs(camTargetTheta - camTheta) < 0.005) {
                    camPhi = camTargetPhi;
                    camTheta = camTargetTheta;
                    camAnimating = false;
                }
            }

            earthCamera.position.x = camRadius * Math.sin(camPhi) * Math.cos(camTheta);
            earthCamera.position.y = camRadius * Math.cos(camPhi);
            earthCamera.position.z = camRadius * Math.sin(camPhi) * Math.sin(camTheta);
            earthCamera.lookAt(0, 0, 0);

            if (earthClouds && earthClouds.visible) {
                earthClouds.rotation.y += 0.00035;
            }

            if (currentLocationMarker) {
                const t = performance.now() * 0.001;
                currentLocationMarker.children.forEach(child => {
                    if (child.userData && child.userData.pulseOffset !== undefined) {
                        const phase = (t + child.userData.pulseOffset) % 2;
                        const scale = 1 + phase * 0.7;
                        child.scale.set(scale, scale, scale);
                        if (child.material) {
                            child.material.opacity = Math.max(0, 0.75 - phase * 0.5);
                        }
                    }
                });
            }

            earthRenderer.render(earthScene, earthCamera);
        }
        animate();

        window.addEventListener("resize", () => {
            if (!earthRenderer || !earthCamera) return;
            const newSize = container.clientWidth || 320;
            earthRenderer.setSize(newSize, newSize);
            earthCamera.aspect = 1;
            earthCamera.updateProjectionMatrix();
        });

        const toggleBtn = w.getElement("toggle-clouds");
        if (toggleBtn) {
            toggleBtn.addEventListener("click", () => {
                cloudsVisible = !cloudsVisible;
                if (earthClouds) earthClouds.visible = cloudsVisible;
                toggleBtn.classList.toggle("off", !cloudsVisible);
                toggleBtn.textContent = cloudsVisible ? "☁️ Clouds" : "☁️ Clouds Off";
            });
        }

        const starBtn = w.getElement("toggle-stars");
        if (starBtn) {
            starBtn.addEventListener("click", () => {
                starsVisible = !starsVisible;
                if (earthStars) earthStars.visible = starsVisible;
                starBtn.classList.toggle("stars-off", !starsVisible);
            });
        }

        const lockBtn = w.getElement("toggle-lock");
        if (lockBtn) {
            lockBtn.textContent = globeLockedOnCity ? "🔒 Locked on city" : "🔓 Auto-rotate";
            lockBtn.addEventListener("click", () => {
                globeLockedOnCity = !globeLockedOnCity;
                lockBtn.textContent = globeLockedOnCity ? "🔒 Locked on city" : "🔓 Auto-rotate";
                if (globeLockedOnCity) {
                    autoRotatePausedUntil = Infinity;
                } else {
                    autoRotatePausedUntil = 0;
                }
            });
        }

        if ("IntersectionObserver" in window) {
            const io = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    globeInView = entry.isIntersecting;
                });
            }, { threshold: 0.05 });
            io.observe(container);
        }

        startEarthClock();

        earthInitialized = true;
        updateSavedMarkers(w.getSavedLocations ? w.getSavedLocations() : []);
    }

    /* ---------- Public API ---------- */
    window.EarthGlobe = {
        init: initEarth,
        updateCurrentMarker,
        rotateGlobeTo,
        updateSavedMarkers,
        renderPanel,
        updateSaveButton
    };
})();