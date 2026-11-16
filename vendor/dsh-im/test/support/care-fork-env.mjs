// care fork: the upstream update-subsystem tests exercise self-update, which the
// fork disables by default (see plugin-src/host/update-runtime.mjs).
process.env.DSH_IM_ALLOW_SELF_UPDATE ??= '1';
