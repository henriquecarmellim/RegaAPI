function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[FATAL] Variável de ambiente ${name} não definida (veja .env.example)`);
    process.exit(1);
  }
  return v;
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  // 0.0.0.0 = acessível na rede (o ESP32 precisa alcançar o servidor); 127.0.0.1 = só este computador
  host: process.env.HOST ?? "0.0.0.0",
  deviceToken: required("ESP32_TOKEN"),
  sessionSecret: required("SESSION_SECRET"),
  adminUser: required("ADMIN_USER"),
  adminPass: required("ADMIN_PASS"),
  dbPath: process.env.DB_PATH ?? "database/rega.sqlite",
};
