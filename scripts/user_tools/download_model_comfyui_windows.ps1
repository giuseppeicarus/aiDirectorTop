# Scarica modelli ComfyUI in .\models (eseguire dalla root di ComfyUI)
# Uso: powershell -ExecutionPolicy Bypass -File download_model_comfyui_windows.ps1
$ErrorActionPreference = "Stop"
$BaseDir = Join-Path (Get-Location) "models"

function Download-Model {
    param(
        [string]$Url,
        [string]$Folder,
        [string]$Filename
    )

    $destDir = Join-Path $BaseDir $Folder
    $destFile = Join-Path $destDir $Filename

    Write-Host "======================================"
    Write-Host "Controllo file: $Filename"
    Write-Host "Destinazione: $destFile"
    Write-Host "======================================"

    if (-not (Test-Path $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }

    if (Test-Path $destFile) {
        Write-Host "[SKIP] File già presente: $Filename"
        Write-Host ""
        return
    }

    Write-Host "[DOWNLOAD] Avvio download..."

    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
        & curl.exe -L -C - --fail --progress-bar -o $destFile $Url
    } else {
        $ProgressPreference = "Continue"
        Invoke-WebRequest -Uri $Url -OutFile $destFile -UseBasicParsing
    }

    if (Test-Path $destFile) {
        Write-Host "[OK] Download completato: $Filename"
    } else {
        Write-Host "[ERRORE] Download fallito: $Filename"
        exit 1
    }

    Write-Host ""
}

# LTX 2.3
Download-Model "https://huggingface.co/Lightricks/LTX-2.3-fp8/resolve/main/ltx-2.3-22b-dev-fp8.safetensors" "checkpoints" "ltx-2.3-22b-dev-fp8.safetensors"
Download-Model "https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-spatial-upscaler-x2-1.1.safetensors" "latent_upscale_models" "ltx-2.3-spatial-upscaler-x2-1.1.safetensors"
Download-Model "https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-22b-distilled-lora-384.safetensors" "loras" "ltx-2.3-22b-distilled-lora-384.safetensors"
Download-Model "https://huggingface.co/LiconStudio/Ltx2.3-VBVR-lora-I2V/resolve/main/Ltx2.3-Licon-VBVR-I2V-96000-R32.safetensors" "loras" "Ltx2.3-Licon-VBVR-I2V-96000-R32.safetensors"
Download-Model "https://huggingface.co/Comfy-Org/ltx-2/resolve/main/split_files/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors" "text_encoders" "gemma_3_12B_it_fp4_mixed.safetensors"

# QWEN IMAGE
Download-Model "https://huggingface.co/alibaba-pai/Qwen-Image-2512-Fun-Controlnet-Union/resolve/main/Qwen-Image-2512-Fun-Controlnet-Union-2602.safetensors" "controlnet" "Qwen-Image-2512-Fun-Controlnet-Union-2602.safetensors"
Download-Model "https://huggingface.co/lightx2v/Qwen-Image-Lightning/resolve/main/Qwen-Image-Lightning-4steps-V1.0.safetensors" "loras" "Qwen-Image-Lightning-4steps-V1.0.safetensors"
Download-Model "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors" "vae" "qwen_image_vae.safetensors"
Download-Model "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors" "text_encoders" "qwen_2.5_vl_7b_fp8_scaled.safetensors"
Download-Model "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors" "diffusion_models" "qwen_image_2512_fp8_e4m3fn.safetensors"

# Z IMAGE
Download-Model "https://huggingface.co/Comfy-Org/z_image/resolve/main/split_files/diffusion_models/z_image_bf16.safetensors" "diffusion_models" "z_image_bf16.safetensors"
Download-Model "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors" "diffusion_models" "z_image_turbo_bf16.safetensors"
Download-Model "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors" "text_encoders" "qwen_3_4b.safetensors"
Download-Model "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors" "vae" "ae.safetensors"

# FLUX 2
Download-Model "https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/diffusion_models/flux2_dev_fp8mixed.safetensors" "diffusion_models" "flux2_dev_fp8mixed.safetensors"

# UPSCALERS
Download-Model "https://huggingface.co/dtarnow/UPscaler/resolve/main/RealESRGAN_x2plus.pth" "upscale_models" "RealESRGAN_x2plus.pth"
Download-Model "https://huggingface.co/ai-forever/Real-ESRGAN/resolve/main/RealESRGAN_x4plus.pth" "upscale_models" "RealESRGAN_x4plus.pth"
Download-Model "https://huggingface.co/ai-forever/Real-ESRGAN/resolve/main/RealESRGAN_x4plus_anime_6B.pth" "upscale_models" "RealESRGAN_x4plus_anime_6B.pth"
Download-Model "https://huggingface.co/ai-forever/Real-ESRGAN/resolve/main/realesr-general-x4v3.pth" "upscale_models" "realesr-general-x4v3.pth"

Write-Host "======================================"
Write-Host "Tutti i download completati."
Write-Host "======================================"
