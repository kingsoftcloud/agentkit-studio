export default String.raw`
[data-studio-routemind-overview] {
  max-width: 960px;
  container-type: inline-size;
}
.rm-figure {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
  align-items: center;
  gap: clamp(18px, 3vw, 36px);
  margin: 0;
  padding: 28px 32px;
  color: #222840;
  background: #f1f3fb;
  border-radius: 12px;
  overflow: hidden;
}
.rm-caption h3 { margin: 0; font-size: clamp(22px, 3vw, 31px); line-height: 1.25; font-weight: 650; }
.rm-caption p { margin: 10px 0 0; color: #4e5669; line-height: 1.6; }
.rm-illustration {
  width: 100%;
  height: auto;
  display: block;
  border: 1px solid #dce1f0;
  border-radius: 12px;
  box-shadow: 0 8px 22px #3b487517;
}
.rm-note { color: var(--dsw-alias-label-secondary, #676767); margin: 14px 0 0; line-height: 1.6; }
@container (max-width: 660px) {
  .rm-figure { grid-template-columns: 1fr; padding: 23px; gap: 19px; }
  .rm-illustration { max-width: 410px; justify-self: center; }
}
`;
