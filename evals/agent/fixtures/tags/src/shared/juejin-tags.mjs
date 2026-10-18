// 从文渡标签事故提炼的故障夹具；只验证双击与标签重排的纯逻辑。
export function isFirstJuejinTagClick(detail) {
  return detail >= 1;
}

export function toggleJuejinTagId(ids, id) {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id].slice(0, 3);
}
