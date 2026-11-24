export function inputModalities(model = {}) {
  const architecture = model.architecture && typeof model.architecture === 'object' ? model.architecture : {};
  return model.input_modalities || model.inputModalities || architecture.input_modalities || architecture.inputModalities || model.input;
}

export function modelInput(model = {}) {
  const values = inputModalities(model);
  return ['text', ...(Array.isArray(values) && values.some(value => ['image', '图片', '图像'].includes(value)) ? ['image'] : [])];
}
