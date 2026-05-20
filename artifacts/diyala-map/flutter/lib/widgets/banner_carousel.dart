// ============================================================================
//  banner_carousel.dart
//  ديالى — سلايدر البنر العلوي مع دعم فيديو يوتيوب / بث مباشر
//
//  الاستخدام في pubspec.yaml:
//    dependencies:
//      youtube_player_flutter: ^9.1.1   # أو أحدث إصدار متوافق
//      cloud_firestore: ^5.x.x
//      cached_network_image: ^3.x.x
//
//  كيفية الدمج في الشاشة الرئيسية:
//    BannerCarousel()
//
//  هيكل Firestore (settings/top_banner):
//    value: JSON string  →  List<MediaItem>
//    مثال عنصر يوتيوب:
//      { "type": "youtube", "url": "https://youtu.be/XXXXXXXXXXX",
//        "customHeight": 220, "objectFit": "cover" }
// ============================================================================

import 'dart:async';
import 'dart:convert';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:cached_network_image/cached_network_image.dart';
import 'package:youtube_player_flutter/youtube_player_flutter.dart';

// ── Design tokens (matches web neon palette) ─────────────────────────────────
const _kBg     = Color(0xFF05080F);
const _kSurf   = Color(0xFF0D1117);
const _kPurple = Color(0xFF7B2FF7);
const _kBlue   = Color(0xFF00D4FF);
const _kGreen  = Color(0xFF00F5D4);

// ── Media item model ──────────────────────────────────────────────────────────
class _MediaItem {
  final String type;        // "image" | "video" | "youtube"
  final String url;
  final double customHeight;
  final BoxFit objectFit;

  const _MediaItem({
    required this.type,
    required this.url,
    this.customHeight = 190,
    this.objectFit    = BoxFit.cover,
  });

  factory _MediaItem.fromMap(Map<String, dynamic> m) {
    BoxFit fit;
    switch ((m['objectFit'] as String?) ?? 'cover') {
      case 'contain': fit = BoxFit.contain; break;
      case 'fill':    fit = BoxFit.fill;    break;
      default:        fit = BoxFit.cover;
    }
    return _MediaItem(
      type:         (m['type'] as String?) ?? 'image',
      url:          (m['url']  as String?) ?? '',
      customHeight: ((m['customHeight'] as num?) ?? 190).toDouble(),
      objectFit:    fit,
    );
  }
}

// ── YouTube ID extractor (mirrors web helper) ─────────────────────────────────
String? _extractYouTubeId(String url) {
  final uri = Uri.tryParse(url);
  if (uri == null) return null;
  // youtu.be/<id>
  if (uri.host == 'youtu.be') return uri.pathSegments.firstOrNull;
  // youtube.com/watch?v=<id>
  if (uri.queryParameters.containsKey('v')) return uri.queryParameters['v'];
  // youtube.com/embed/<id>  |  /live/<id>  |  /shorts/<id>
  if (uri.pathSegments.length >= 2 &&
      ['embed', 'live', 'shorts'].contains(uri.pathSegments[0])) {
    return uri.pathSegments[1];
  }
  return null;
}

// ── BannerCarousel (public widget) ────────────────────────────────────────────
class BannerCarousel extends StatefulWidget {
  const BannerCarousel({super.key});

  @override
  State<BannerCarousel> createState() => _BannerCarouselState();
}

class _BannerCarouselState extends State<BannerCarousel> {
  List<_MediaItem> _items   = [];
  int              _current = 0;
  bool             _loading = true;

  StreamSubscription? _firestoreSub;
  Timer?              _autoPlay;
  final PageController _pageCtrl = PageController();

  @override
  void initState() {
    super.initState();
    _subscribeFirestore();
  }

  @override
  void dispose() {
    _firestoreSub?.cancel();
    _autoPlay?.cancel();
    _pageCtrl.dispose();
    super.dispose();
  }

  // ── Firestore listener ────────────────────────────────────────────────────
  void _subscribeFirestore() {
    _firestoreSub = FirebaseFirestore.instance
        .collection('settings')
        .doc('top_banner')
        .snapshots()
        .listen((snap) {
      if (!snap.exists) { setState(() => _loading = false); return; }
      final raw = (snap.data()?['value'] as String?) ?? '';
      final items = _parseItems(raw);
      if (mounted) {
        setState(() {
          _items   = items;
          _loading = false;
          _current = 0;
        });
        _startAutoPlay();
      }
    }, onError: (_) {
      if (mounted) setState(() => _loading = false);
    });
  }

  List<_MediaItem> _parseItems(String raw) {
    if (raw.isEmpty) return [];
    try {
      final decoded = jsonDecode(raw);
      if (decoded is List) {
        return decoded
            .whereType<Map<String, dynamic>>()
            .map(_MediaItem.fromMap)
            .where((e) => e.url.isNotEmpty)
            .toList();
      }
    } catch (_) { /* */ }
    if (raw.isNotEmpty) return [_MediaItem(type: 'image', url: raw)];
    return [];
  }

  // ── Auto-slide (every 5 s, skip YouTube slides — they play themselves) ────
  void _startAutoPlay() {
    _autoPlay?.cancel();
    if (_items.length <= 1) return;
    _autoPlay = Timer.periodic(const Duration(seconds: 5), (_) {
      if (!mounted || _items.isEmpty) return;
      // Don't auto-advance if current slide is a YouTube item (user is watching)
      if (_items[_current].type == 'youtube') return;
      final next = (_current + 1) % _items.length;
      _pageCtrl.animateToPage(
        next,
        duration: const Duration(milliseconds: 450),
        curve: Curves.easeInOut,
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return _buildSkeleton();
    if (_items.isEmpty) return const SizedBox.shrink();

    final height = _items[_current].customHeight;

    return AnimatedContainer(
      duration: const Duration(milliseconds: 300),
      height: height,
      child: Stack(
        children: [
          // ── PageView ────────────────────────────────────────────────────
          PageView.builder(
            controller: _pageCtrl,
            itemCount:  _items.length,
            onPageChanged: (i) => setState(() => _current = i),
            itemBuilder: (ctx, i) => _buildSlide(_items[i]),
          ),

          // ── Top neon edge ──────────────────────────────────────────────
          Positioned(
            top: 0, left: 0, right: 0,
            child: Container(
              height: 2,
              decoration: const BoxDecoration(
                gradient: LinearGradient(colors: [
                  Colors.transparent, _kPurple, _kBlue, Colors.transparent,
                ]),
              ),
            ),
          ),

          // ── Dots indicator (bottom-center, only when >1 item) ─────────
          if (_items.length > 1)
            Positioned(
              bottom: 8, left: 0, right: 0,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: List.generate(_items.length, (i) {
                  final active = i == _current;
                  return AnimatedContainer(
                    duration: const Duration(milliseconds: 250),
                    margin: const EdgeInsets.symmetric(horizontal: 3),
                    width:  active ? 18 : 6,
                    height: 4,
                    decoration: BoxDecoration(
                      color: active ? _kPurple : Colors.white24,
                      borderRadius: BorderRadius.circular(2),
                      boxShadow: active
                          ? [BoxShadow(color: _kPurple.withOpacity(0.7), blurRadius: 6)]
                          : null,
                    ),
                  );
                }),
              ),
            ),

          // ── Bottom neon edge ──────────────────────────────────────────
          Positioned(
            bottom: 0, left: 0, right: 0,
            child: Container(
              height: 1,
              decoration: BoxDecoration(
                gradient: LinearGradient(colors: [
                  Colors.transparent,
                  _kPurple.withOpacity(0.6),
                  _kBlue.withOpacity(0.6),
                  Colors.transparent,
                ]),
              ),
            ),
          ),
        ],
      ),
    );
  }

  // ── Individual slide ───────────────────────────────────────────────────────
  Widget _buildSlide(_MediaItem item) {
    switch (item.type) {
      case 'youtube':
        return _YouTubeSlide(url: item.url);
      case 'video':
        return _VideoSlide(url: item.url, fit: item.objectFit);
      default:
        return _ImageSlide(url: item.url, fit: item.objectFit);
    }
  }

  // ── Loading skeleton ────────────────────────────────────────────────────────
  Widget _buildSkeleton() {
    return Container(
      height: 190,
      color: _kBg,
      child: Center(
        child: SizedBox(
          width: 28, height: 28,
          child: CircularProgressIndicator(
            strokeWidth: 2,
            color: _kPurple.withOpacity(0.6),
          ),
        ),
      ),
    );
  }
}

// ── Image slide ────────────────────────────────────────────────────────────────
class _ImageSlide extends StatelessWidget {
  final String url;
  final BoxFit fit;
  const _ImageSlide({required this.url, required this.fit});

  @override
  Widget build(BuildContext context) {
    return CachedNetworkImage(
      imageUrl: url,
      fit:      fit,
      width:    double.infinity,
      height:   double.infinity,
      placeholder: (_, __) => Container(color: _kBg),
      errorWidget: (_, __, ___) => Container(
        color: _kSurf,
        child: const Icon(Icons.broken_image_outlined,
            color: Colors.white24, size: 32),
      ),
    );
  }
}

// ── Video slide (for uploaded MP4 / WebM URLs) ─────────────────────────────────
// NOTE: إذا أردت دعم فيديو MP4 من الرابط المباشر، استخدم مكتبة video_player
// هنا نعرض صورة ثابتة كـ fallback — يمكن تطويرها لاحقاً
class _VideoSlide extends StatelessWidget {
  final String url;
  final BoxFit fit;
  const _VideoSlide({required this.url, required this.fit});

  @override
  Widget build(BuildContext context) {
    return Container(
      color: _kSurf,
      child: const Center(
        child: Icon(Icons.play_circle_outline, color: _kBlue, size: 48),
      ),
    );
  }
}

// ── YouTube slide ──────────────────────────────────────────────────────────────
class _YouTubeSlide extends StatefulWidget {
  final String url;
  const _YouTubeSlide({required this.url});

  @override
  State<_YouTubeSlide> createState() => _YouTubeSlideState();
}

class _YouTubeSlideState extends State<_YouTubeSlide> {
  YoutubePlayerController? _ctrl;
  bool _error = false;

  @override
  void initState() {
    super.initState();
    final id = _extractYouTubeId(widget.url);
    if (id == null || id.isEmpty) {
      _error = true;
      return;
    }
    _ctrl = YoutubePlayerController(
      initialVideoId: id,
      flags: const YoutubePlayerFlags(
        autoPlay:          true,
        mute:              false,
        isLive:            false,   // ⚠ عدّلها إلى true إذا كان بثاً مباشراً
        forceHD:           false,
        enableCaption:     false,
        hideControls:      false,
        controlsVisibleAtStart: true,
      ),
    );
  }

  @override
  void dispose() {
    _ctrl?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_error || _ctrl == null) {
      return Container(
        color: _kSurf,
        child: const Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.youtube_searched_for, color: Colors.red, size: 36),
              SizedBox(height: 8),
              Text(
                'رابط يوتيوب غير صحيح',
                style: TextStyle(
                  fontFamily: 'Rajdhani',
                  color: Colors.white54,
                  fontSize: 13,
                ),
              ),
            ],
          ),
        ),
      );
    }

    return YoutubePlayerBuilder(
      player: YoutubePlayer(
        controller:  _ctrl!,
        showVideoProgressIndicator: true,
        progressIndicatorColor: _kPurple,
        progressColors: const ProgressBarColors(
          playedColor:  _kPurple,
          handleColor:  _kBlue,
          bufferedColor: Colors.white24,
          backgroundColor: Colors.black26,
        ),
        onReady: () {
          _ctrl!.play();
        },
      ),
      builder: (ctx, player) {
        return SizedBox.expand(child: player);
      },
    );
  }
}
