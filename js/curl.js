/* A real page curl.
 *
 * StPageFlip folds a page about a hinge: flat plane, straight crease. That is
 * why its shadows read as flat -- a linear gradient is the physically correct
 * shading for a flat surface. The iPad effect is a *cylinder*: the sheet wraps
 * a tube whose axis follows your finger, so the silhouette bulges, the far
 * edge lifts, light runs along the roll, and the back of the sheet shows
 * through. None of that is reachable with CSS transforms, which are affine.
 *
 * So: live DOM while at rest (text selectable, crisp), and during the ~400ms
 * of motion a WebGL quad running the curl. The geometry follows the classic
 * cylindrical formulation -- arc length to the front surface, arc length to
 * the back, sample whichever the fragment lands on.
 *
 * Rasterisation uses SVG <foreignObject>, so the *browser* rasterises the page
 * with its own text engine. That matters more than speed: a JS re-implementation
 * of text rendering (html2canvas and friends) differs subtly from the live DOM,
 * and the mismatch shows as a visible pop the instant the texture swaps in.
 */
'use strict';

window.Curl = (function () {
  const VERT = `#version 300 es
  in vec2 a_pos;
  out vec2 v_uv;
  void main() {
    v_uv = a_pos * 0.5 + 0.5;
    v_uv.y = 1.0 - v_uv.y;
    gl_Position = vec4(a_pos, 0.0, 1.0);
  }`;

  const FRAG = `#version 300 es
  precision highp float;

  in vec2 v_uv;
  out vec4 outColor;

  uniform sampler2D u_front;   // the page being turned
  uniform sampler2D u_back;    // what is revealed underneath
  uniform vec2  u_origin;      // a point on the curl axis, in uv
  uniform vec2  u_dir;         // unit vector, direction of travel
  uniform float u_radius;      // cylinder radius, in uv-x units
  uniform float u_aspect;      // page w/h, to keep the cylinder round

  const float PI = 3.14159265;

  // Correct for aspect so the curl axis is not sheared on a tall page.
  vec2 aspectify(vec2 p) { return vec2(p.x, p.y / u_aspect); }

  void main() {
    vec2 uv = v_uv;
    vec2 p  = aspectify(uv);
    vec2 o  = aspectify(u_origin);
    vec2 d  = normalize(aspectify(u_dir));

    // Signed distance from this fragment to the curl axis.
    float dist = dot(p - o, d);

    vec4 color;
    float shade = 1.0;

    if (dist > u_radius) {
      // Ahead of the roll: the page is still flat and untouched.
      color = texture(u_front, uv);

    } else if (dist > -u_radius) {
      // On the cylinder. theta is where around the roll we are.
      float theta = asin(clamp(dist / u_radius, -1.0, 1.0));

      // Two candidate points map here: one on the near (front) surface and
      // one further round on the far (back) surface.
      float arcFront = theta * u_radius;
      float arcBack  = (PI - theta) * u_radius;

      vec2 base   = p - d * dist;
      vec2 pFront = base + d * arcFront;
      vec2 pBack  = base + d * arcBack;

      vec2 uvFront = vec2(pFront.x, pFront.y * u_aspect);
      vec2 uvBack  = vec2(pBack.x,  pBack.y  * u_aspect);

      bool backVisible = all(greaterThanEqual(uvBack, vec2(0.0))) &&
                         all(lessThanEqual(uvBack, vec2(1.0)));

      if (backVisible) {
        // Looking at the reverse of the sheet: mirrored, desaturated toward
        // the paper, and lit from behind near the thin lifted edge.
        vec4 b = texture(u_front, vec2(1.0 - uvBack.x, uvBack.y));
        float grey = dot(b.rgb, vec3(0.299, 0.587, 0.114));
        vec3 paper = mix(b.rgb, vec3(grey), 0.72);
        paper = mix(paper, vec3(0.96, 0.945, 0.91), 0.42);
        float backlight = pow(1.0 - abs(dist / u_radius), 0.2);
        color = vec4(paper * (0.82 + 0.18 * backlight), 1.0);

        // Specular along the roll: the single strongest "this is real" cue.
        float ndl = max(0.0, cos(theta - 0.55));
        color.rgb += vec3(0.30) * pow(ndl, 26.0);

      } else if (all(greaterThanEqual(uvFront, vec2(0.0))) &&
                 all(lessThanEqual(uvFront, vec2(1.0)))) {
        color = texture(u_front, uvFront);
        // The front face darkens as it rolls away from the light.
        shade = 0.72 + 0.28 * cos(theta);
        color.rgb *= shade;
        float ndl = max(0.0, cos(theta + 0.35));
        color.rgb += vec3(0.22) * pow(ndl, 34.0);

      } else {
        color = texture(u_back, uv);
      }

    } else {
      // Past the roll: the revealed page, with the turning sheet's shadow
      // falling across it. Tightest at the crease, fading with distance.
      color = texture(u_back, uv);
      float t = clamp((-dist - u_radius) / (u_radius * 2.4), 0.0, 1.0);
      color.rgb *= mix(0.46, 1.0, pow(t, 0.55));
    }

    outColor = color;
  }`;

  let gl = null;
  let canvas = null;
  let program = null;
  let texFront = null;
  let texBack = null;
  let loc = {};

  function init(width, height) {
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'curl-canvas';
      gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false });
      if (!gl) return false;

      program = link(VERT, FRAG);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW
      );
      const a = gl.getAttribLocation(program, 'a_pos');
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);

      for (const n of ['u_front', 'u_back', 'u_origin', 'u_dir', 'u_radius', 'u_aspect']) {
        loc[n] = gl.getUniformLocation(program, n);
      }
      texFront = makeTexture();
      texBack = makeTexture();
    }

    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    gl.viewport(0, 0, canvas.width, canvas.height);
    return true;
  }

  function link(vsrc, fsrc) {
    const vs = compile(gl.VERTEX_SHADER, vsrc);
    const fs = compile(gl.FRAGMENT_SHADER, fsrc);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('curl link: ' + gl.getProgramInfoLog(p));
    }
    gl.useProgram(p);
    return p;
  }

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('curl compile: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  function makeTexture() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    // No mipmaps: they cost a third more memory and a page is never minified.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  function upload(tex, image) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  }

  /* An <img> inside <foreignObject> is *not* rendered when the SVG is used as
     an image source -- external references are blocked, and the page comes
     back with every photograph missing (verified: zero non-white pixels).
     So each asset is inlined as a data URI. Cached by URL, because the same
     image recurs across the pages of one article and re-encoding a 300KB JPEG
     per turn is exactly the hitch we cannot afford. */
  const dataUrlCache = new Map();

  async function toDataUrl(url) {
    if (dataUrlCache.has(url)) return dataUrlCache.get(url);
    const promise = fetch(url)
      .then((r) => r.blob())
      .then(
        (blob) =>
          new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(fr.result);
            fr.onerror = rej;
            fr.readAsDataURL(blob);
          })
      )
      .catch(() => null);
    dataUrlCache.set(url, promise);
    return promise;
  }

  /** Pre-encode the images a page needs, so a turn never waits on the network. */
  async function warm(el) {
    const urls = [...el.querySelectorAll('img')].map((i) => i.src).filter(Boolean);
    await Promise.all(urls.map(toDataUrl));
  }

  /**
   * Rasterise a DOM element via <foreignObject>, so the browser's own text
   * engine does the work and the texture matches the live page exactly.
   */
  async function capture(el, width, height, cssText) {
    const clone = el.cloneNode(true);

    // Swap every image for its inlined copy before serialising.
    const imgs = [...clone.querySelectorAll('img')];
    await Promise.all(
      imgs.map(async (img) => {
        const data = await toDataUrl(img.src);
        if (data) {
          img.setAttribute('src', data);
        } else {
          img.remove();
        }
      })
    );
    clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    clone.style.width = width + 'px';
    clone.style.height = height + 'px';
    clone.style.margin = '0';
    clone.style.transform = 'none';

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<foreignObject width="100%" height="100%">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px">` +
      `<style>${cssText}</style>${new XMLSerializer().serializeToString(clone)}` +
      `</div></foreignObject></svg>`;

    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    const img = new Image();
    img.decoding = 'sync';
    img.src = url;
    await img.decode();
    return img;
  }

  function draw(progress, corner) {
    if (!gl) return;
    gl.useProgram(program);

    // The roll starts off the trailing edge and sweeps across. Radius eases
    // down at the very end so the sheet lands flat rather than snapping.
    const radius = 0.13 * Math.min(1, (1 - progress) * 3.2 + 0.22);
    const x = 1.0 - progress * (1.0 + radius * 2.0);

    gl.uniform2f(loc.u_origin, x, corner < 0 ? 0.0 : 1.0);
    gl.uniform2f(loc.u_dir, 1.0, corner * 0.16);
    gl.uniform1f(loc.u_radius, radius);
    gl.uniform1f(loc.u_aspect, canvas.width / canvas.height);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texFront);
    gl.uniform1i(loc.u_front, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texBack);
    gl.uniform1i(loc.u_back, 1);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  return {
    supported: () => {
      try {
        return !!document.createElement('canvas').getContext('webgl2');
      } catch (e) {
        return false;
      }
    },
    init,
    capture,
    warm,
    upload,
    draw,
    get canvas() { return canvas; },
    get textures() { return { front: texFront, back: texBack }; },
  };
})();
