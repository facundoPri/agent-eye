import { UserError } from './util.js';

/** Check a profile against what the camera says it supports. Returns a list of problems (empty = fine). */
export function androidProblems(profile, caps) {
  const problems = [];
  const size = `${profile.width}x${profile.height}`;
  const normal = caps.sizes.includes(size) && caps.fps.includes(profile.fps);
  const slowMo = caps.highSpeed.some((h) => h.size === size && h.fps.includes(profile.fps));
  if (!normal && !slowMo) {
    const hs = caps.highSpeed.find((h) => h.size === size);
    if (!caps.sizes.includes(size) && !hs) problems.push(`${size} is not a supported size for this camera.`);
    else problems.push(`${size} does not support ${profile.fps} fps. Allowed: ${[...new Set([...(caps.sizes.includes(size) ? caps.fps : []), ...(hs?.fps ?? [])])].sort((a, b) => a - b).join(', ')}.`);
  }
  const [zmin, zmax] = caps.zoomRange;
  if (profile.zoom < zmin || profile.zoom > zmax) problems.push(`zoom ${profile.zoom} is outside this camera's range ${zmin}-${zmax}.`);
  if (profile.focus !== undefined) {
    if (!caps.focusRange) problems.push('this camera has no manual focus: remove "focus" (autofocus).');
    else if (profile.focus > caps.focusRange[1]) problems.push(`focus ${profile.focus} is closer than this camera can focus (0-${caps.focusRange[1]} diopters, nearest ${Math.round(100 / caps.focusRange[1])} cm).`);
  }
  const locks = caps.locks ?? [];
  if (profile.exposureLock && !locks.includes('ae')) problems.push('this camera cannot lock exposure.');
  if (profile.whiteBalanceLock && !locks.includes('awb')) problems.push('this camera cannot lock white balance.');
  return problems;
}

export function macProblems(profile, modes) {
  if (!modes.length) return [];
  const size = `${profile.width}x${profile.height}`;
  const mode = modes.find((m) => m.size === size);
  if (!mode) return [`${size} is not supported. Available: ${modes.map((m) => m.size).join(', ')}.`];
  if (profile.fps > mode.maxFps) return [`${size} supports up to ${mode.maxFps} fps on this camera.`];
  return [];
}

export function assertSupported(profile, device, modes = []) {
  const problems = device.kind === 'android' ? androidProblems(profile, device.caps) : macProblems(profile, modes);
  if (problems.length) throw new UserError(`The camera cannot do that:\n  - ${problems.join('\n  - ')}`, { code: 2 });
}
