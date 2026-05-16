// ============================================================================
//  ar_bounty_view.dart
//  ديالى — شاشة الواقع المعزز لصيد الكنز
//
//  ⚠️  ملف معزول للتطوير المستقبلي — غير مرتبط بواجهة الويب الحالية.
//
//  المتطلبات (أضفها إلى pubspec.yaml عند التفعيل):
//    ar_flutter_plugin: ^0.7.3
//    cloud_firestore: ^4.x.x
//    firebase_auth: ^4.x.x
//    confetti: ^0.7.0
//    geolocator: ^10.x.x
//    vector_math: ^2.1.4
// ============================================================================

import 'dart:async';
import 'dart:math' as math;

import 'package:ar_flutter_plugin/ar_flutter_plugin.dart';
import 'package:ar_flutter_plugin/datatypes/config_planedetection.dart';
import 'package:ar_flutter_plugin/datatypes/node_types.dart';
import 'package:ar_flutter_plugin/managers/ar_anchor_manager.dart';
import 'package:ar_flutter_plugin/managers/ar_location_manager.dart';
import 'package:ar_flutter_plugin/managers/ar_object_manager.dart';
import 'package:ar_flutter_plugin/managers/ar_session_manager.dart';
import 'package:ar_flutter_plugin/models/ar_anchor.dart';
import 'package:ar_flutter_plugin/models/ar_node.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:confetti/confetti.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:vector_math/vector_math_64.dart' as vm;

// ── Theme colours (matches web neon palette) ─────────────────────────────────
const _kYellow  = Color(0xFFF5C518);
const _kGreen   = Color(0xFF00DC64);
const _kRed     = Color(0xFFFF2D50);
const _kBlue    = Color(0xFF00D4FF);
const _kBg      = Color(0xFF05080F);
const _kSurface = Color(0xFF0D1117);

// ── Data model passed from the map screen ────────────────────────────────────
class BountyMissionArData {
  final String id;
  final String title;
  final String description;
  final int    reward;        // Iraqi Dinar
  final double latitude;
  final double longitude;

  const BountyMissionArData({
    required this.id,
    required this.title,
    required this.description,
    required this.reward,
    required this.latitude,
    required this.longitude,
  });
}

// ── Screen ────────────────────────────────────────────────────────────────────
class ArBountyView extends StatefulWidget {
  final BountyMissionArData mission;

  const ArBountyView({super.key, required this.mission});

  @override
  State<ArBountyView> createState() => _ArBountyViewState();
}

class _ArBountyViewState extends State<ArBountyView>
    with TickerProviderStateMixin {

  // ── AR managers ─────────────────────────────────────────────────────────
  ARSessionManager?  _arSessionManager;
  ARObjectManager?   _arObjectManager;
  ARAnchorManager?   _arAnchorManager;
  ARLocationManager? _arLocationManager;

  // ── State ────────────────────────────────────────────────────────────────
  bool   _arReady      = false;
  bool   _chestPlaced  = false;
  bool   _claiming     = false;
  bool   _claimed      = false;
  bool   _tooFar       = true;
  double _distanceM    = double.infinity;
  String? _error;

  // ── AR node reference ────────────────────────────────────────────────────
  ARNode?   _chestNode;
  ARAnchor? _chestAnchor;

  // ── Confetti ─────────────────────────────────────────────────────────────
  late final ConfettiController _confetti;

  // ── Pulse animation for the AR chest ────────────────────────────────────
  late final AnimationController _pulseCtrl;
  late final Animation<double>   _pulseAnim;

  // ── Countdown timer (30 s to claim once in range) ────────────────────────
  static const _kClaimWindowSec = 30;
  int      _countdownSec = _kClaimWindowSec;
  Timer?   _countdownTimer;
  bool     _countdownActive = false;

  // ── GPS stream ───────────────────────────────────────────────────────────
  StreamSubscription<Position>? _posStream;

  // ── Claim radius (must be ≤ 20 m — same as web) ──────────────────────────
  static const _kClaimRadiusM = 20.0;

  // ── 3D model path (glTF/GLB stored in assets/models/) ────────────────────
  // Replace with your actual golden chest GLB file path.
  static const _kChestModelUri = 'assets/models/golden_chest.glb';

  // ────────────────────────────────────────────────────────────────────────────
  @override
  void initState() {
    super.initState();

    _confetti = ConfettiController(duration: const Duration(seconds: 4));

    _pulseCtrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1400),
    )..repeat(reverse: true);
    _pulseAnim = Tween<double>(begin: 0.9, end: 1.12).animate(
      CurvedAnimation(parent: _pulseCtrl, curve: Curves.easeInOut),
    );

    _startGpsWatch();
  }

  @override
  void dispose() {
    _confetti.dispose();
    _pulseCtrl.dispose();
    _countdownTimer?.cancel();
    _posStream?.cancel();
    _arSessionManager?.dispose();
    super.dispose();
  }

  // ── GPS watch ─────────────────────────────────────────────────────────────
  Future<void> _startGpsWatch() async {
    bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      setState(() => _error = 'خدمة GPS غير مفعّلة');
      return;
    }

    LocationPermission perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied) {
      perm = await Geolocator.requestPermission();
    }
    if (perm == LocationPermission.deniedForever ||
        perm == LocationPermission.denied) {
      setState(() => _error = 'لا يوجد إذن للوصول إلى الموقع');
      return;
    }

    _posStream = Geolocator.getPositionStream(
      locationSettings: const LocationSettings(
        accuracy: LocationAccuracy.bestForNavigation,
        distanceFilter: 2,
      ),
    ).listen(_onPositionUpdate);
  }

  void _onPositionUpdate(Position pos) {
    final dist = Geolocator.distanceBetween(
      pos.latitude,  pos.longitude,
      widget.mission.latitude, widget.mission.longitude,
    );

    final wasClose = !_tooFar;
    final nowClose = dist <= _kClaimRadiusM;

    setState(() {
      _distanceM = dist;
      _tooFar    = !nowClose;
    });

    // Start countdown when user enters claim radius for the first time
    if (nowClose && !wasClose && !_countdownActive && !_claimed) {
      _startCountdown();
    }

    // Place or update the AR chest position relative to user
    if (_arReady && !_chestPlaced) {
      _placeChestNode(pos);
    }
  }

  // ── Countdown timer ───────────────────────────────────────────────────────
  void _startCountdown() {
    setState(() {
      _countdownActive = true;
      _countdownSec    = _kClaimWindowSec;
    });
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) { t.cancel(); return; }
      setState(() {
        _countdownSec--;
        if (_countdownSec <= 0) {
          t.cancel();
          _countdownActive = false;
          _countdownSec    = _kClaimWindowSec;
        }
      });
    });
  }

  // ── AR session callbacks ───────────────────────────────────────────────────
  void _onARViewCreated(
    ARSessionManager  sessionMgr,
    ARObjectManager   objectMgr,
    ARAnchorManager   anchorMgr,
    ARLocationManager locationMgr,
  ) {
    _arSessionManager  = sessionMgr;
    _arObjectManager   = objectMgr;
    _arAnchorManager   = anchorMgr;
    _arLocationManager = locationMgr;

    sessionMgr.onInitialize(
      showFeaturePoints:      false,
      showPlanes:             true,
      handlePans:             false,
      handleRotation:         false,
      showAnimatedGuide:      false,
    );

    objectMgr.onInitialize();

    // Tap on any AR node → attempt claim
    objectMgr.onNodeTap = _onChestTap;

    setState(() => _arReady = true);
  }

  // ── Place the 3D golden chest in the AR scene ─────────────────────────────
  // Uses a GeoAnchor positioned at the mission's real-world coordinates.
  Future<void> _placeChestNode(Position userPos) async {
    if (_chestPlaced || _arObjectManager == null || _arAnchorManager == null) {
      return;
    }

    // Calculate offset vector from user to mission (AR local space approximation)
    final dLat = widget.mission.latitude  - userPos.latitude;
    final dLng = widget.mission.longitude - userPos.longitude;
    final northM = dLat * 111_320.0;
    final eastM  = dLng * 111_320.0 * math.cos(userPos.latitude * math.pi / 180);

    // Clamp distance so the chest is always visible (max 5 m visual distance)
    final realDist = math.sqrt(northM * northM + eastM * eastM);
    final scale    = realDist > 0 ? math.min(1.0, 5.0 / realDist) : 1.0;

    final anchor = ARPlaneAnchor(
      transformation: Matrix4.translation(
        vm.Vector3(eastM * scale, 0.0, -northM * scale),
      ),
    );

    final anchorAdded = await _arAnchorManager!.addAnchor(anchor);
    if (!anchorAdded) return;

    final node = ARNode(
      type:           NodeType.localGLTF2,
      uri:            _kChestModelUri,
      scale:          vm.Vector3(0.35, 0.35, 0.35),
      position:       vm.Vector3.zero(),
      rotation:       vm.Vector4(0, 1, 0, 0),
      name:           'golden_chest_${widget.mission.id}',
    );

    final nodeAdded = await _arObjectManager!.addNode(node, planeAnchor: anchor);
    if (nodeAdded) {
      setState(() {
        _chestAnchor = anchor;
        _chestNode   = node;
        _chestPlaced = true;
      });
    }
  }

  // ── Handle tap on the AR chest ─────────────────────────────────────────────
  Future<void> _onChestTap(List<String> nodeNames) async {
    if (!nodeNames.contains('golden_chest_${widget.mission.id}')) return;
    if (_tooFar)    { _showSnack('اقترب أكثر من الموقع الفعلي للمهمة'); return; }
    if (!_countdownActive && !_tooFar) {
      // Edge case: user tapped before countdown started → start it first
      _startCountdown();
      _showSnack('الآن! لديك $_kClaimWindowSec ثانية لاستلام الجائزة — اضغط مرة أخرى');
      return;
    }
    if (_claiming || _claimed) return;

    await _claimMission();
  }

  // ── Firestore atomic claim transaction ────────────────────────────────────
  // Mirrors the web BountyMissionSystem transaction exactly.
  Future<void> _claimMission() async {
    setState(() => _claiming = true);

    final uid      = FirebaseAuth.instance.currentUser?.uid;
    final db       = FirebaseFirestore.instance;
    final missionRef = db.collection('bounty_missions').doc(widget.mission.id);

    try {
      await db.runTransaction((txn) async {
        final snap = await txn.get(missionRef);

        if (!snap.exists || snap.data()?['status'] != 'active') {
          throw FirebaseException(
            plugin: 'cloud_firestore',
            code:   'already-claimed',
            message: 'already_claimed',
          );
        }

        final prize = (snap.data()?['reward'] as num?)?.toInt() ?? 0;

        // ① Mark mission claimed
        txn.update(missionRef, {
          'status':    'claimed',
          'claimedBy': uid ?? 'anonymous',
          'claimedAt': FieldValue.serverTimestamp(),
        });

        // ② Credit wallet — atomic increment
        if (uid != null && prize > 0) {
          final userRef = db.collection('users').doc(uid);
          txn.set(
            userRef,
            {'balance': FieldValue.increment(prize)},
            SetOptions(merge: true),
          );
        }
      });

      // ── Success ─────────────────────────────────────────────────────────
      _countdownTimer?.cancel();
      _confetti.play();
      setState(() {
        _claimed  = true;
        _claiming = false;
      });

      // Remove chest node from scene
      if (_chestNode != null && _chestAnchor != null) {
        await _arObjectManager?.removeNode(_chestNode!);
        await _arAnchorManager?.removeAnchor(_chestAnchor!);
      }

    } on FirebaseException catch (e) {
      setState(() => _claiming = false);
      if (e.code == 'already-claimed') {
        _showSnack('سبقك شخص آخر — الجائزة محجوزة ⚡');
      } else {
        _showSnack('خطأ: ${e.message}');
      }
    } catch (e) {
      setState(() => _claiming = false);
      _showSnack('خطأ في الاتصال — حاول مرة أخرى');
    }
  }

  void _showSnack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg, style: const TextStyle(fontFamily: 'Rajdhani', fontSize: 14)),
        backgroundColor: _kSurface,
        behavior: SnackBarBehavior.floating,
        duration: const Duration(seconds: 3),
      ),
    );
  }

  // ── UI ─────────────────────────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _kBg,
      body: Stack(
        children: [

          // ── AR camera view ──────────────────────────────────────────────
          if (_error == null)
            ARView(
              onARViewCreated: _onARViewCreated,
              planeDetectionConfig:
                  PlaneDetectionConfig.horizontalAndVertical,
            ),

          // ── Error state ──────────────────────────────────────────────────
          if (_error != null)
            _buildErrorOverlay(),

          // ── Top bar ─────────────────────────────────────────────────────
          _buildTopBar(),

          // ── Distance HUD ────────────────────────────────────────────────
          _buildDistanceHud(),

          // ── Countdown ring (when in range) ───────────────────────────────
          if (_countdownActive && !_claimed)
            _buildCountdownRing(),

          // ── Claim prompt (tap chest hint) ─────────────────────────────
          if (!_tooFar && _chestPlaced && !_claimed && !_claiming)
            _buildTapHint(),

          // ── Claiming overlay ─────────────────────────────────────────────
          if (_claiming)
            _buildClaimingOverlay(),

          // ── Success overlay ──────────────────────────────────────────────
          if (_claimed)
            _buildSuccessOverlay(),

          // ── Confetti ────────────────────────────────────────────────────
          Align(
            alignment: Alignment.topCenter,
            child: ConfettiWidget(
              confettiController: _confetti,
              blastDirectionality: BlastDirectionality.explosive,
              numberOfParticles: 60,
              gravity: 0.18,
              colors: const [_kYellow, _kGreen, _kBlue, Colors.white, _kRed],
              emissionFrequency: 0.06,
              minBlastForce: 8,
              maxBlastForce: 22,
            ),
          ),
        ],
      ),
    );
  }

  // ── Widgets ──────────────────────────────────────────────────────────────

  Widget _buildTopBar() {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Row(
          children: [
            // Back button
            GestureDetector(
              onTap: () => Navigator.of(context).pop(),
              child: Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: _kSurface.withOpacity(0.88),
                  border: Border.all(color: _kYellow.withOpacity(0.3)),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: const Icon(Icons.arrow_back_ios_new,
                    color: _kYellow, size: 16),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                decoration: BoxDecoration(
                  color: _kSurface.withOpacity(0.88),
                  border: Border.all(color: _kYellow.withOpacity(0.25)),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      '⚡ AR BOUNTY MISSION',
                      style: TextStyle(
                        fontFamily: 'Orbitron',
                        fontSize: 8,
                        color: _kYellow.withOpacity(0.8),
                        letterSpacing: 1.8,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      widget.mission.title,
                      style: const TextStyle(
                        fontFamily: 'Rajdhani',
                        fontSize: 14,
                        fontWeight: FontWeight.w700,
                        color: Colors.white,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 12),
            // Reward badge
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: _kYellow.withOpacity(0.1),
                border: Border.all(color: _kYellow.withOpacity(0.4)),
                borderRadius: BorderRadius.circular(4),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text('🎁', style: TextStyle(fontSize: 14)),
                  Text(
                    '${_formatNumber(widget.mission.reward)}',
                    style: const TextStyle(
                      fontFamily: 'Orbitron',
                      fontSize: 9,
                      color: _kYellow,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const Text(
                    'د.ع',
                    style: TextStyle(
                      fontFamily: 'Rajdhani',
                      fontSize: 8,
                      color: _kYellow,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildDistanceHud() {
    final inRange = !_tooFar;
    final dist    = _distanceM < 1000
        ? '${_distanceM.toStringAsFixed(0)} م'
        : '${(_distanceM / 1000).toStringAsFixed(1)} كم';

    return Positioned(
      bottom: 160,
      left: 0,
      right: 0,
      child: Center(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          decoration: BoxDecoration(
            color: _kSurface.withOpacity(0.88),
            border: Border.all(
              color: (inRange ? _kGreen : _kYellow).withOpacity(0.35),
            ),
            borderRadius: BorderRadius.circular(4),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              // Pulse dot
              AnimatedContainer(
                duration: const Duration(milliseconds: 600),
                width: 8, height: 8,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: inRange ? _kGreen : _kYellow,
                  boxShadow: [
                    BoxShadow(
                      color: (inRange ? _kGreen : _kYellow).withOpacity(0.6),
                      blurRadius: 8, spreadRadius: 2,
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 10),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    inRange ? '✓ أنت داخل نطاق المهمة' : '📍 المسافة عن الهدف',
                    style: TextStyle(
                      fontFamily: 'Orbitron',
                      fontSize: 7,
                      color: (inRange ? _kGreen : _kYellow).withOpacity(0.9),
                      letterSpacing: 1.2,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    inRange ? 'ابحث عن الصندوق في الكاميرا 🎯' : dist,
                    style: TextStyle(
                      fontFamily: 'Rajdhani',
                      fontSize: 15,
                      fontWeight: FontWeight.w700,
                      color: inRange ? _kGreen : Colors.white,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildCountdownRing() {
    final progress = _countdownSec / _kClaimWindowSec;
    final color    = _countdownSec > 10 ? _kGreen : _kRed;

    return Positioned(
      bottom: 80,
      left: 0,
      right: 0,
      child: Center(
        child: Container(
          width: 72, height: 72,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: _kSurface.withOpacity(0.88),
            border: Border.all(color: color.withOpacity(0.5), width: 2),
            boxShadow: [
              BoxShadow(color: color.withOpacity(0.3), blurRadius: 16),
            ],
          ),
          child: Stack(
            alignment: Alignment.center,
            children: [
              SizedBox(
                width: 64, height: 64,
                child: CircularProgressIndicator(
                  value:     progress,
                  color:     color,
                  strokeWidth: 4,
                  backgroundColor: color.withOpacity(0.15),
                ),
              ),
              Text(
                '$_countdownSec',
                style: TextStyle(
                  fontFamily: 'Orbitron',
                  fontSize: 18,
                  fontWeight: FontWeight.bold,
                  color: color,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildTapHint() {
    return Positioned(
      bottom: 30,
      left: 0,
      right: 0,
      child: Center(
        child: AnimatedBuilder(
          animation: _pulseAnim,
          builder: (_, child) => Transform.scale(
            scale: _pulseAnim.value,
            child: child,
          ),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
            decoration: BoxDecoration(
              color: _kYellow.withOpacity(0.15),
              border: Border.all(color: _kYellow.withOpacity(0.6), width: 1.5),
              borderRadius: BorderRadius.circular(4),
              boxShadow: [
                BoxShadow(color: _kYellow.withOpacity(0.25), blurRadius: 20),
              ],
            ),
            child: const Text(
              '👆 اضغط على الصندوق الذهبي لاستلام الجائزة',
              style: TextStyle(
                fontFamily: 'Rajdhani',
                fontSize: 14,
                fontWeight: FontWeight.w700,
                color: _kYellow,
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildClaimingOverlay() {
    return Container(
      color: Colors.black.withOpacity(0.72),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const CircularProgressIndicator(color: _kYellow, strokeWidth: 3),
            const SizedBox(height: 16),
            const Text(
              'جاري استلام الجائزة...',
              style: TextStyle(
                fontFamily: 'Orbitron',
                fontSize: 13,
                color: _kYellow,
                letterSpacing: 1.4,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSuccessOverlay() {
    return Container(
      color: _kBg.withOpacity(0.9),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('🎉', style: TextStyle(fontSize: 72)),
            const SizedBox(height: 16),
            const Text(
              'تهانينا!',
              style: TextStyle(
                fontFamily: 'Orbitron',
                fontSize: 28,
                color: _kYellow,
                fontWeight: FontWeight.bold,
                letterSpacing: 2,
              ),
            ),
            const SizedBox(height: 8),
            const Text(
              'استلمت الجائزة بنجاح',
              style: TextStyle(
                fontFamily: 'Rajdhani',
                fontSize: 18,
                color: Colors.white70,
              ),
            ),
            const SizedBox(height: 20),
            Text(
              '🎁 ${_formatNumber(widget.mission.reward)} دينار',
              style: const TextStyle(
                fontFamily: 'Orbitron',
                fontSize: 22,
                color: _kYellow,
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 8),
            const Text(
              'أضيف إلى محفظتك فوراً',
              style: TextStyle(
                fontFamily: 'Rajdhani',
                fontSize: 14,
                color: _kGreen,
              ),
            ),
            const SizedBox(height: 32),
            GestureDetector(
              onTap: () => Navigator.of(context).pop(true),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 14),
                decoration: BoxDecoration(
                  color: _kGreen.withOpacity(0.15),
                  border: Border.all(color: _kGreen.withOpacity(0.6), width: 1.5),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: const Text(
                  'العودة إلى الخريطة',
                  style: TextStyle(
                    fontFamily: 'Orbitron',
                    fontSize: 11,
                    color: _kGreen,
                    letterSpacing: 1.2,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildErrorOverlay() {
    return Container(
      color: _kBg,
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.camera_alt_outlined, color: _kRed, size: 52),
            const SizedBox(height: 16),
            Text(
              _error!,
              style: const TextStyle(
                fontFamily: 'Rajdhani',
                fontSize: 16,
                color: Colors.white70,
              ),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            GestureDetector(
              onTap: () { setState(() => _error = null); _startGpsWatch(); },
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
                decoration: BoxDecoration(
                  border: Border.all(color: _kBlue.withOpacity(0.5)),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: const Text(
                  'إعادة المحاولة',
                  style: TextStyle(
                    fontFamily: 'Orbitron',
                    fontSize: 10,
                    color: _kBlue,
                    letterSpacing: 1.2,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ── Utils ─────────────────────────────────────────────────────────────────
  String _formatNumber(int n) {
    final s = n.toString();
    final buf = StringBuffer();
    for (int i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 == 0) buf.write(',');
      buf.write(s[i]);
    }
    return buf.toString();
  }
}
