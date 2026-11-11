// Open-weight models Peeblo's teammates use, as listed on hosted Otari (checked Nov 6, 2026).
// Logos: @lobehub/icons-static-svg (MIT), copied to /public/brands/models.

export type Model = { id: string; name: string; maker: string; logo: string; good: string };

export const models: Model[] = [
  { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", maker: "DeepSeek", logo: "/brands/models/deepseek-color.svg", good: "everyday jobs" },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", maker: "DeepSeek", logo: "/brands/models/deepseek-color.svg", good: "the hard problems" },
  { id: "moonshotai/kimi-k3", name: "Kimi K3", maker: "Moonshot AI", logo: "/brands/models/kimi-color.svg", good: "research and long reads" },
  { id: "z-ai/glm-5.3", name: "GLM-5.3", maker: "Z.ai", logo: "/brands/models/zhipu-color.svg", good: "writing code" },
  { id: "alibaba/qwen3.8-27b", name: "Qwen3.8 27B", maker: "Qwen", logo: "/brands/models/qwen-color.svg", good: "quick, cheap jobs" },
  { id: "minimax/minimax-m3", name: "MiniMax M3", maker: "MiniMax", logo: "/brands/models/minimax-color.svg", good: "jobs that use many tools" },
  { id: "nvidia/nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra", maker: "NVIDIA", logo: "/brands/models/nvidia-color.svg", good: "a second opinion on a teammate's work" },
];

export const modelByShort = (short: string) => models.find((m) => m.id.endsWith(short) || m.name === short);
