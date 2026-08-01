export class CameraService {
  constructor() {
    this.stream = null;
    this.video = null;
    this.canvas = null;
    this.config = null;
  }

  setVideoElement(videoElement) {
    this.video = videoElement;
  }

  setCanvasElement(canvasElement) {
    this.canvas = canvasElement;
  }

  // TODO [Basic] Tambahkan konfigurasi kamera untuk mendapatkan daftar perangkat input video
  // TODO [Basic] Dapatkan constraints kamera berdasarkan konfigurasi dan kamera yang dipilih
  async loadCameras() {}

  // TODO [Basic] Memulai kamera dengan perangkat yang dipilih dan menampilkan pada elemen video
  async startCamera(selectedCameraId) {}

  // TODO [Basic] Menghentikan siaran kamera dan membersihkan sumber daya
  stopCamera() {}

  // TODO [Skilled] Implementasikan metode untuk mengatur FPS kamera
  setFPS(fps) {}

  // TODO [Basic] Periksa apakah kamera sedang aktif
  isActive() {}

  // TODO [Basic] Periksa apakah elemen video siap untuk digunakan
  isReady() {}
}