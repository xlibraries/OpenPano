# OpenPano

![cmu0](results/CMU0-all.jpg)

## Introduction

OpenPano is a panorama stitching program written in C++ from scratch (without any vision libraries). It mainly follows the routine
described in the paper [Automatic Panoramic Image Stitching using Invariant Features](http://matthewalunbrown.com/papers/ijcv2007.pdf),
which is also the one used by [AutoStitch](http://matthewalunbrown.com/autostitch/autostitch.html).

## Installation

We need the following dependencies:
* gcc >= 5, clang >= 10 or visual studio >= 2015. CMake >= 3.20
* [Eigen](http://eigen.tuxfamily.org/index.php?title=Main_Page)
* libjpeg (optional, if you only need png format)
* [FLANN](http://www.cs.ubc.ca/research/flann/) (already included in the repository, slightly modified)
* [CImg](http://cimg.eu/) (optional. already included in the repository)

Eigen, CImg and FLANN are header-only, to simplify the compilation on different platforms.
CImg and libjpeg are only used to read and write images, so you can easily get rid of them.

### Linux

On ArchLinux, install dependencies by:
```
sudo pacman -S gcc sed cmake make libjpeg eigen
```

On Ubuntu, install dependencies by:
```
sudo apt install build-essential sed cmake libjpeg-dev libeigen3-dev
```

### macOS

#### Prerequisites

1. **Xcode Command Line Tools**: The C++ compiler and system headers are provided by Apple's developer tools. Install them and accept the license:
```
xcode-select --install
sudo xcodebuild -license accept
```

2. **Homebrew dependencies**: Install the required libraries using [Homebrew](https://brew.sh/):
```
brew install cmake eigen libjpeg
```

#### OpenMP (optional, for multi-threaded performance)

The default Apple Clang shipped with Xcode does **not** include OpenMP support. Without it, the program will compile and run correctly, but will use only a single thread (slower for large image sets).

To enable OpenMP, you have two options:

* **Option A** — Install `libomp` for use with Apple Clang:
  ```
  brew install libomp
  ```
  Then configure cmake with:
  ```
  cmake -B build \
    -DOpenMP_CXX_FLAGS="-Xclang -fopenmp" \
    -DOpenMP_CXX_LIB_NAMES="omp" \
    -DOpenMP_omp_LIBRARY=$(brew --prefix libomp)/lib/libomp.dylib \
    -DCMAKE_CXX_FLAGS="-I$(brew --prefix libomp)/include"
  make -C build
  ```

* **Option B** — Use GCC instead of Apple Clang:
  ```
  brew install gcc
  cmake -B build -DCMAKE_CXX_COMPILER=g++-14
  make -C build
  ```

See [#16](https://github.com/ppwwyyxx/OpenPano/issues/16) for more details.

#### Eigen path note (Makefile only)

If you use the Makefile build (`make -C src`) instead of cmake, note that the default Eigen include path for macOS is `/usr/local/include/eigen3`. On Apple Silicon Macs, Homebrew installs to `/opt/homebrew`, so you will need to override it:
```
make -C src EIGEN3_INCLUDE_DIR=/opt/homebrew/include/eigen3
```
The cmake build handles this automatically via `find_package(Eigen3)` and is the recommended approach on macOS.

### Compile

#### Linux / macOS / WSL (bash on windows)
Use cmake (recommended):
```
$ cmake -B build && make -C build
# Binary will be found at ./build/src/image-stitching
```
or, use make (more customizable. You can modify Makefile when you run into problems.):
```
$ make -C src
# Binary will be found at ./src/image-stitching
```

#### Windows (for VS2015)
* Install cmake, VS2015
* Set environment variable `Eigen3_DIR` to `{YOUR_EIGEN3_DIRECTORY}/eigen3/cmake`.
* Open Visual Studio [Developer Command Prompt](https://msdn.microsoft.com/en-us/library/ms229859(v=vs.110).aspx).
* `cd path/to/OpenPano`
* `cmake .`
* Open the VS2015 project and compile the project
* copy `config.cfg` to the directory containing `image-stitching.exe`
* The author have never used Visual Studio and this windows build process may not work for you. Feel
	free to submit PR to improve the build process.

## Usage

### Quick Start (generate.sh)

The `generate.sh` script handles building and running the full pipeline:

```bash
# Build the C++ stitcher
./generate.sh build

# Convert a video to panorama
./generate.sh stitch video.mp4 -o ./output --verbose

# Stitch images directly
./generate.sh stitch-images img1.jpg img2.jpg img3.jpg

# See all options
./generate.sh help
```

### Video to Panorama (video2pano.py)

Automatically extracts frames from video, scores for quality/sharpness, selects the best frames, and stitches them:

```bash
# Basic usage
python3 video2pano.py input.mp4

# With output directory and verbose logging
python3 video2pano.py input.mp4 -o ./results --verbose

# Override focal length (35mm equivalent, in mm)
python3 video2pano.py input.mp4 --focal-length 28

# Keep extracted frames for inspection
python3 video2pano.py input.mp4 -o ./results --keep-frames

# Use a custom config file
python3 video2pano.py input.mp4 -c my_config.conf
```

**Dependencies:** ffmpeg (frame extraction), Python 3.7+, OpenCV (optional, for Laplacian blur detection — falls back to file-size scoring if unavailable).

```bash
# Install dependencies (macOS)
brew install ffmpeg
pip3 install opencv-python   # optional but recommended
```

**Output:** JSON result on stdout, progress on stderr. Exit codes: 0=success, 1=quality too low, 2=input error, 3=stitcher error.

The pipeline automatically:
- Adapts SIFT parameters for the video's resolution
- Detects and rejects blurry frames (Laplacian variance when OpenCV is available, file-size fallback otherwise)
- Selects optimally-spaced sharp frames
- Tries the best stitching mode (ESTIMATE_CAMERA for unknown focal length, CYLINDER when focal is known)
- Falls back to alternate mode if the first fails
- Retries with a connected subset if the frame chain breaks

### Configuration

**`video2pano.conf`** — All tunable parameters for the video-to-panorama pipeline (quality thresholds, SIFT sensitivity, RANSAC, camera defaults). Edit this file to customize behavior. See comments in the file for details.

**`config.cfg`** — Direct stitcher configuration (used when running `image-stitching` binary directly). The video2pano pipeline generates this automatically from `video2pano.conf`.

### Stitching Images Directly

```
$ ./build/src/image-stitching <file1> <file2> ...
```

The output file is ``out.jpg``. The program reads `config.cfg` from the working directory. You can play with the [example data](https://github.com/ppwwyyxx/OpenPano/releases/tag/0.1) to start with.

Before dealing with very large images (4 megapixels or more), it's better to manually downscale them to save time. In cylinder/translation mode, the input file names need to have the correct order.

### Stitching Modes

Three modes are available (set in config):

+ __cylinder__ mode. Best quality for horizontal pans with known focal length.
	+ You stay at the same spot and __only__ turn left (or right), no translations.
	+ Images are taken with the same camera, with a known ``FOCAL_LENGTH`` set in config.
	+ Images are given in the left-to-right order.

+ __camera estimation__ mode. Most flexible, works with arbitrary rotation.
  * You stay at the same spot, can turn left-right or up-down.
  * Don't use too few images. Runs slower (pairwise matching).

+ __translation__ mode. For camera moving sideways (not rotating).
  * Camera performs pure translation. Images at roughly the same depth.
  * Input images ordered by translation direction.

Key config options:
+ __FOCAL_LENGTH__: focal length in [35mm equivalent](https://en.wikipedia.org/wiki/35_mm_equivalent_focal_length). Used in cylinder mode and as fallback when camera estimation can't determine focal.
+ __ORDERED_INPUT__: whether input images are ordered sequentially. Must be `1` in CYLINDER and TRANS mode.
+ __CROP__: whether to crop the final image to avoid irregular white border.

The default values are generally good for images with more than 0.7 megapixels.
If your images are too small, it might be better to resize them rather than tune parameters.


## Examples ([All original data available for __download__](https://github.com/ppwwyyxx/OpenPano/releases/tag/0.1))

Zijing Apartment in Tsinghua University:
![dorm](results/apartment.jpg)

"Myselves":
![myself](results/myself.jpg)

<!--
   -Zijing Playground in Tsinghua University:
   -![planet](https://github.com/ppwwyyxx/panorama/raw/master/results/planet.jpg)
	 -->

Carnegie Mellon University from 38 images
![apple](results/apple.jpg)

Newell-Simon Hall in CMU (this one is hard because objects are closer):
![nsh](results/NSH-all.jpg)

A full-view pano built from UAV images:
![uav](results/uav.jpg)

For more examples, see [results](results).

## Speed & Memory
Tested on Intel Core i7-6700HQ, with `ESTIMATE_CAMERA` mode:

+ 11 ordered images of size 600x400: 3.2s.
+ 13 ordered images of size 1500x1112: 6s.
+ 38 unordered images of size 1300x867 (high vertical FOV): 51s.

Memory consumption is known to be huge with default libc allocator.
Simply using a modern allocator (e.g. tcmalloc, jemalloc) can help a lot.
Also, setting `LAZY_READ` to 1 can save memory at the cost of a minor slow down.

Peak memory in bytes (assume each input has the same w & h):

+ Without `LAZY_READ` option: max(finalw \* finalh \* 12, #photos \* w \* h \* 12 + #photos \* #matched\_pairs * 96 + #keypoints * 520)
+ With `LAZY_READ` option: max(finalw \* finalh \* 16, #threads \* w \* h \* 12, #photos \* #matched\_pairs * 96 + #keypoints * 520)

## Algorithms
+ Features: [SIFT](http://en.wikipedia.org/wiki/Scale-invariant_feature_transform)
+ Transformation: use [RANSAC](http://en.wikipedia.org/wiki/RANSAC) to estimate a homography or affine transformation.
+ Optimization: focal estimation, [bundle adjustment](https://en.wikipedia.org/wiki/Bundle_adjustment), and some straightening tricks.

For details, see [my blog post](http://ppwwyyxx.com/blog/2016/How-to-Write-a-Panorama-Stitcher/).

## Quality Guidelines

To get the best stitching quality:
+ While rotating the camera for different shots, try to keep the position of camera lens static.
+ Keep the exposure parameters unchanged.
+ Do not shoot on moving objects.
+ Objects far away will stitch better.
+ The algorithm doesn't work well with wide-angle cameras where images are distorted heavily. Camera
	parameters are needed to undistort the images.

## TODOs
+ Github Actions for macOS and Windows
+ apply pairwise matching for translation mode as well
+ run bundle adjustment on sphere lens instead of perspective lens
+ improve feature detector and matching
+ use LAZY_READ & 1 byte image in both blender to reduce peak memory
+ clean up use of copies of `ImageRef`
+ faster gaussian blur kernel
+ port some hotspot (e.g. `dist.cc`) to neon
+ support read/write EXIF metadata to:
	+ get focal length, distortion, etc
	+ allow pano to be viewed on Facebook
+ python bindings
