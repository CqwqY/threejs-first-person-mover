// 职责：朝向校准面板（?calib 呼出）。两个滑块分别实时调节「模型朝向」与「骨骼角度」，
// 并显示当前度数，方便把准确角度回填到 PlayerModel 的默认 cfg 中。
import { getDebugYaw, setDebugYaw } from '../player/PlayerModel.js';

export function initDebugYawPanel() {
  if (document.getElementById('yawcal-panel')) return;

  const panel = document.createElement('div');
  panel.id = 'yawcal-panel';
  panel.style.cssText =
    'position:fixed;top:12px;right:12px;z-index:99999;background:rgba(15,15,15,.85);color:#fff;' +
    'font:12px/1.6 monospace;padding:12px 16px;border-radius:8px;min-width:250px;user-select:none;';

  const title = document.createElement('div');
  title.textContent = '朝向校准（拖动滑块实时生效）';
  title.style.cssText = 'font-weight:bold;margin-bottom:8px;letter-spacing:.5px;';

  // 模型朝向
  const mRow = _row(panel, '模型朝向 (deg)', title);
  const mLabel = mRow.label;
  const mSlider = mRow.slider;

  // 骨架走向（蒙皮反补，身体不动）
  const bRow = _row(panel, '骨架走向 (deg)', title);
  const bLabel = bRow.label;
  const bSlider = bRow.slider;

  // 说明
  const hint = document.createElement('div');
  hint.style.cssText = 'color:#8f9aa8;font-size:11px;margin-top:8px;';
  hint.textContent = '模型朝向：直接转整个模型。骨架走向：只转骨架（身体不动），改走路摆腿方向。满意后把两个度数报给开发者。';
  panel.appendChild(hint);

  // 用 cfg 同步两个滑块与度数显示
  const syncFromCfg = () => {
    const s = getDebugYaw();
    mSlider.value = s.modelDeg;
    mLabel.textContent = `${s.modelDeg.toFixed(1)} deg`;
    bSlider.value = s.skelDeg;
    bLabel.textContent = `${s.skelDeg.toFixed(1)} deg`;
  };
  // 只更新度数文字（不碰滑块值，避免拖动时被拉回）
  const updateLabels = (mv, bv) => {
    mLabel.textContent = `${mv.toFixed(1)} deg`;
    bLabel.textContent = `${bv.toFixed(1)} deg`;
  };
  // 拖动模型朝向滑块时实时生效
  mSlider.addEventListener('input', () => {
    setDebugYaw(parseFloat(mSlider.value), parseFloat(bSlider.value));
    updateLabels(parseFloat(mSlider.value), parseFloat(bSlider.value));
  });
  // 骨架走向：实时生效（无重建），直接调用
  bSlider.addEventListener('input', () => {
    bLabel.textContent = `${parseFloat(bSlider.value).toFixed(1)} deg`;
    setDebugYaw(parseFloat(mSlider.value), parseFloat(bSlider.value));
  });
  bSlider.addEventListener('change', syncFromCfg);

  document.body.appendChild(panel);
  syncFromCfg();
}

// 生成一行「标签 + 滑块」，返回引用
function _row(panel, label, title) {
  const labelEl = document.createElement('div');
  labelEl.textContent = label;
  labelEl.style.cssText = 'color:#c7d0da;';

  const valueEl = document.createElement('span');
  valueEl.style.cssText = 'color:#ffd479;margin-left:8px;';

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;margin-top:6px;';
  head.appendChild(labelEl);
  head.appendChild(valueEl);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '-180';
  slider.max = '180';
  slider.step = '1';
  slider.style.cssText = 'width:100%;margin:4px 0;accent-color:#4aa3ff;';

  panel.appendChild(head);
  panel.appendChild(slider);

  return { label: valueEl, slider };
}