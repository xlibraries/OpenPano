export interface PipelineResult {
  status: "success" | "error";
  output_path?: string;
  error_message?: string;
  error_code?: string;
  video?: {
    path: string;
    width: number;
    height: number;
    fps: number;
    duration: number;
    total_frames: number;
    rotation: number;
    codec: string;
    focal_length_35mm: number | null;
  };
  quality?: {
    total_frames_extracted: number;
    frames_passing_sharpness: number;
    frames_selected: number;
    sharpness_pass_rate: number;
    filesize_threshold_bytes: number;
    mean_laplacian: number;
    min_laplacian_selected: number;
    focal_length_35mm: number;
    focal_source: string;
    frames_stitched: number;
  };
  stitch?: {
    final_size: [number, number];
    stitched_size: [number, number];
    duration_seconds: number;
    backend?: string;
    mode: string;
    projection: string;
    fov?: {
      haov: number;
      vaov: number;
      center_yaw: number;
      center_pitch: number;
    };
    pannellum: {
      type: string;
      panorama: string;
      autoLoad: boolean;
      haov?: number;
      vaov?: number;
      vOffset?: number;
      avoidShowingBackground?: boolean;
      minHfov?: number;
      maxHfov?: number;
    };
  };
  warnings?: string[];
  timing?: {
    probe_seconds: number;
    extract_seconds: number;
    score_seconds: number;
    select_seconds: number;
    stitch_seconds: number;
    total_seconds: number;
  };
}

export interface ProgressData {
  stage: string;
  percent: number;
  detail: string;
}
