#!/usr/bin/env bash
# Scarica modelli ComfyUI in ./models (eseguire dalla root di ComfyUI)
set -euo pipefail

BASE_DIR="./models"

download_model() {
  local url="$1"
  local folder="$2"
  local filename="$3"

  local dest_dir="${BASE_DIR}/${folder}"
  local dest_file="${dest_dir}/${filename}"

  echo "======================================"
  echo "Controllo file: ${filename}"
  echo "Destinazione: ${dest_file}"
  echo "======================================"

  mkdir -p "$dest_dir"

  if [ -f "$dest_file" ]; then
    echo "[SKIP] File già presente: ${filename}"
    echo ""
    return
  fi

  echo "[DOWNLOAD] Avvio download..."

  if command -v curl >/dev/null 2>&1; then
    curl -L -C - --fail --progress-bar -o "$dest_file" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -c --show-progress --progress=bar:force:noscroll -O "$dest_file" "$url"
  else
    echo "[ERRORE] Serve curl o wget (installa con: brew install curl wget)"
    exit 1
  fi

  if [ -f "$dest_file" ]; then
    echo "[OK] Download completato: ${filename}"
  else
    echo "[ERRORE] Download fallito: ${filename}"
    exit 1
  fi

  echo ""
}

# =========================================================
# LTX 2.3
# =========================================================

download_model \
"https://huggingface.co/Lightricks/LTX-2.3-fp8/resolve/main/ltx-2.3-22b-dev-fp8.safetensors" \
"checkpoints" \
"ltx-2.3-22b-dev-fp8.safetensors"

download_model \
"https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-spatial-upscaler-x2-1.1.safetensors" \
"latent_upscale_models" \
"ltx-2.3-spatial-upscaler-x2-1.1.safetensors"

download_model \
"https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-22b-distilled-lora-384.safetensors" \
"loras" \
"ltx-2.3-22b-distilled-lora-384.safetensors"

download_model \
"https://huggingface.co/LiconStudio/Ltx2.3-VBVR-lora-I2V/resolve/main/Ltx2.3-Licon-VBVR-I2V-96000-R32.safetensors" \
"loras" \
"Ltx2.3-Licon-VBVR-I2V-96000-R32.safetensors"

download_model \
"https://huggingface.co/Comfy-Org/ltx-2/resolve/main/split_files/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors" \
"text_encoders" \
"gemma_3_12B_it_fp4_mixed.safetensors"

# =========================================================
# QWEN IMAGE
# =========================================================

download_model \
"https://huggingface.co/alibaba-pai/Qwen-Image-2512-Fun-Controlnet-Union/resolve/main/Qwen-Image-2512-Fun-Controlnet-Union-2602.safetensors" \
"controlnet" \
"Qwen-Image-2512-Fun-Controlnet-Union-2602.safetensors"

download_model \
"https://huggingface.co/lightx2v/Qwen-Image-Lightning/resolve/main/Qwen-Image-Lightning-4steps-V1.0.safetensors" \
"loras" \
"Qwen-Image-Lightning-4steps-V1.0.safetensors"

download_model \
"https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors" \
"vae" \
"qwen_image_vae.safetensors"

download_model \
"https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors" \
"text_encoders" \
"qwen_2.5_vl_7b_fp8_scaled.safetensors"

download_model \
"https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors" \
"diffusion_models" \
"qwen_image_2512_fp8_e4m3fn.safetensors"

# =========================================================
# Z IMAGE
# =========================================================

download_model \
"https://huggingface.co/Comfy-Org/z_image/resolve/main/split_files/diffusion_models/z_image_bf16.safetensors" \
"diffusion_models" \
"z_image_bf16.safetensors"

download_model \
"https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors" \
"diffusion_models" \
"z_image_turbo_bf16.safetensors"

download_model \
"https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors" \
"text_encoders" \
"qwen_3_4b.safetensors"

download_model \
"https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors" \
"vae" \
"ae.safetensors"

# =========================================================
# FLUX 2
# =========================================================

download_model \
"https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/diffusion_models/flux2_dev_fp8mixed.safetensors" \
"diffusion_models" \
"flux2_dev_fp8mixed.safetensors"

# =========================================================
# UPSCALERS
# =========================================================

download_model \
"https://huggingface.co/dtarnow/UPscaler/resolve/main/RealESRGAN_x2plus.pth" \
"upscale_models" \
"RealESRGAN_x2plus.pth"

download_model \
"https://huggingface.co/ai-forever/Real-ESRGAN/resolve/main/RealESRGAN_x4plus.pth" \
"upscale_models" \
"RealESRGAN_x4plus.pth"

download_model \
"https://huggingface.co/ai-forever/Real-ESRGAN/resolve/main/RealESRGAN_x4plus_anime_6B.pth" \
"upscale_models" \
"RealESRGAN_x4plus_anime_6B.pth"

download_model \
"https://huggingface.co/ai-forever/Real-ESRGAN/resolve/main/realesr-general-x4v3.pth" \
"upscale_models" \
"realesr-general-x4v3.pth"

echo "======================================"
echo "Tutti i download completati."
echo "======================================"
