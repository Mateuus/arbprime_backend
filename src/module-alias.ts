import moduleAlias from "module-alias";
import path from "path";

// Registrar os aliases para apontar para a pasta `dist/`
moduleAlias.addAliases({
  "@Controllers": path.resolve(__dirname, "controllers"),
  "@Routes": path.resolve(__dirname, "routes"),
  "@Core": path.resolve(__dirname, "core"),
  "@Interfaces": path.resolve(__dirname, "interfaces"),
  "@Gateways": path.resolve(__dirname, "gateways"),
  "@Services": path.resolve(__dirname, "services"),
  "@Enums": path.resolve(__dirname, "enums"),
  "@utils": path.resolve(__dirname, "utils")
});
