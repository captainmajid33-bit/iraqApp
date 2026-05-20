// ============================================================================
//  driver_radar.dart
//  ديالى — رادار سائقي التكسي المتاحين في الوقت الفعلي
//
//  يستخدم StreamBuilder + .snapshots() للتحديث اللحظي بدون إعادة تسجيل دخول.
//  بمجرد أن يضغط السائق "مفتوح/مغلق" في تطبيقه، يتحدث الرادار في أجزاء
//  من الثانية تلقائياً.
//
//  الشروط الثلاثة المطلوبة معاً:
//    1. driverType == 'taxi'      ← فئة التكسي فقط (استبعاد الغاز وغيره)
//    2. isOnline  == true         ← التطبيق مفتوح والسائق متصل
//    3. status    == 'available'  ← ليس في رحلة حالية
//
//  الاستخدام في pubspec.yaml:
//    dependencies:
//      cloud_firestore: ^5.x.x
//      geolocator:      ^11.x.x
//
//  كيفية الاستخدام:
//    DriverRadar(
//      customerLat: position.latitude,
//      customerLng: position.longitude,
//      onDriverSelected: (driver) { ... },
//    )
// ============================================================================

import 'dart:math' as math;

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';

// ── Design tokens ─────────────────────────────────────────────────────────────
const _kBg     = Color(0xFF05080F);
const _kSurf   = Color(0xFF0D1117);
const _kGreen  = Color(0xFF00F5D4);
const _kYellow = Color(0xFFF5C518);
const _kBlue   = Color(0xFF00D4FF);
const _kRed    = Color(0xFFFF2D78);
const _kPurple = Color(0xFF7B2FF7);
const _kDim    = Color(0xFF4A5568);

// ── Driver model ──────────────────────────────────────────────────────────────
class TaxiDriver {
  final String  docId;
  final String  phone;
  final String  name;
  final double  lat;
  final double  lng;
  final double  distanceKm;
  final bool    isOnline;
  final String  status;
  final String  driverType;

  const TaxiDriver({
    required this.docId,
    required this.phone,
    required this.name,
    required this.lat,
    required this.lng,
    required this.distanceKm,
    required this.isOnline,
    required this.status,
    required this.driverType,
  });
}

// ── Haversine distance ─────────────────────────────────────────────────────────
double _haversineKm(double lat1, double lng1, double lat2, double lng2) {
  const r = 6371.0;
  final dLat = (lat2 - lat1) * math.pi / 180;
  final dLng = (lng2 - lng1) * math.pi / 180;
  final a = math.sin(dLat / 2) * math.sin(dLat / 2) +
      math.cos(lat1 * math.pi / 180) *
          math.cos(lat2 * math.pi / 180) *
          math.sin(dLng / 2) *
          math.sin(dLng / 2);
  return r * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a));
}

// ── Firestore bool helper (Flutter writes bool, web may write string) ─────────
bool _isTruthy(dynamic val) {
  if (val == null) return false;
  if (val is bool) return val;
  return val.toString().toLowerCase() == 'true';
}

bool _isAvailable(dynamic val) {
  return val?.toString().toLowerCase() == 'available';
}

bool _isTaxiType(dynamic val) {
  if (val == null) return true; // حقل غير موجود → نعتبره تكسي (backward-compat)
  final s = val.toString().toLowerCase();
  return s == 'taxi' || s.isEmpty;
}

// ── الدالة الرئيسية: Stream حي من Firestore ───────────────────────────────────
// تُعيد Stream يستمع لحظة بلحظة — كل تغيير في isOnline أو status يُفعّل rebuild
// ⚠ isOnline لا نضعه في where() لأن Flutter قد يكتبه bool أو String
//   نفلتره client-side داخل StreamBuilder لضمان قبول كلا النوعين
Stream<QuerySnapshot<Map<String, dynamic>>> getAvailableTaxiDrivers() {
  return FirebaseFirestore.instance
      .collection('drivers')
      .where('driverType', isEqualTo: 'taxi') // server-side: فئة التكسي فقط
      .snapshots();                            // .snapshots() = الاستماع الحي المستمر
}

// ── DriverRadar widget — StatelessWidget + StreamBuilder ──────────────────────
// لا initState ، لا dispose ، لا StreamSubscription يدوي.
// Flutter يدير دورة حياة الـ Stream تلقائياً: يفتحه عند البناء ويغلقه عند التدمير.
class DriverRadar extends StatelessWidget {
  final double                      customerLat;
  final double                      customerLng;
  final double                      radiusKm;
  final void Function(TaxiDriver)?  onDriverSelected;

  const DriverRadar({
    super.key,
    required this.customerLat,
    required this.customerLng,
    this.radiusKm = 15.0,
    this.onDriverSelected,
  });

  // ── تحويل snapshot → قائمة TaxiDriver مُرتّبة ────────────────────────────
  List<TaxiDriver> _parseDrivers(QuerySnapshot<Map<String, dynamic>> snap) {
    final drivers = <TaxiDriver>[];

    for (final doc in snap.docs) {
      final d = doc.data();

      // شرط 1: فئة التكسي (double-check client-side)
      if (!_isTaxiType(d['driverType'])) continue;

      // شرط 2: متصل — يقبل bool true أو String 'true' (Flutter type-mismatch safe)
      if (!_isTruthy(d['isOnline'])) continue;

      // شرط 3: متاح وليس بداخل رحلة
      if (!_isAvailable(d['status'])) continue;

      // الإحداثيات
      final lat = (d['lat'] as num?)?.toDouble() ??
                  (d['latitude'] as num?)?.toDouble();
      final lng = (d['lng'] as num?)?.toDouble() ??
                  (d['longitude'] as num?)?.toDouble();
      if (lat == null || lng == null) continue;

      // شرط 4: ضمن نطاق البحث
      final distKm = _haversineKm(customerLat, customerLng, lat, lng);
      if (distKm > radiusKm) continue;

      drivers.add(TaxiDriver(
        docId:      doc.id,
        phone:      (d['phone']      as String?) ?? '',
        name:       (d['name']       as String?) ??
                    (d['driverName'] as String?) ?? 'سائق',
        lat:        lat,
        lng:        lng,
        distanceKm: distKm,
        isOnline:   true,
        status:     'available',
        driverType: 'taxi',
      ));
    }

    // ترتيب تصاعدي حسب المسافة
    drivers.sort((a, b) => a.distanceKm.compareTo(b.distanceKm));
    return drivers;
  }

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
      // ─── هذا السطر هو قلب الميزة ───────────────────────────────────────────
      // .snapshots() يفتح اتصالاً دائماً مع Firestore.
      // كل مرة يضغط السائق "مفتوح" أو "مغلق" يُطلق Firestore حدثاً جديداً
      // فيُعيد Flutter بناء الـ Widget تلقائياً دون أي تدخل من المستخدم.
      stream: getAvailableTaxiDrivers(),
      builder: (context, snapshot) {
        // حالة التحميل الأولي
        if (snapshot.connectionState == ConnectionState.waiting) {
          return _buildLoading();
        }

        // حالة الخطأ
        if (snapshot.hasError) {
          return _buildError(snapshot.error.toString());
        }

        // لا بيانات بعد
        if (!snapshot.hasData) return _buildLoading();

        // ── تحويل البيانات وتطبيق الفلاتر client-side ────────────────────
        final drivers = _parseDrivers(snapshot.data!);

        if (drivers.isEmpty) return _buildEmpty();

        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // عنوان الرادار
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              child: Row(
                children: [
                  Container(
                    width: 3, height: 20,
                    color: _kGreen,
                    margin: const EdgeInsets.only(right: 8),
                  ),
                  Text(
                    'سائقو التكسي المتاحون  ·  ${drivers.length}',
                    style: const TextStyle(
                      fontFamily: 'Orbitron',
                      fontSize: 10,
                      color: _kGreen,
                      letterSpacing: 1.4,
                    ),
                  ),
                  const Spacer(),
                  _PulseDot(color: _kGreen),
                ],
              ),
            ),

            // قائمة السائقين — تتحدث لحظة بلحظة
            ListView.builder(
              shrinkWrap:  true,
              physics:     const NeverScrollableScrollPhysics(),
              itemCount:   drivers.length,
              itemBuilder: (_, i) => _DriverCard(
                driver: drivers[i],
                onTap:  () => onDriverSelected?.call(drivers[i]),
              ),
            ),
          ],
        );
      },
    );
  }

  // ── حالات المساعدة ────────────────────────────────────────────────────────
  Widget _buildLoading() => Container(
    height: 120,
    alignment: Alignment.center,
    child: const SizedBox(
      width: 28, height: 28,
      child: CircularProgressIndicator(strokeWidth: 2, color: _kPurple),
    ),
  );

  Widget _buildEmpty() => Container(
    margin: const EdgeInsets.all(16),
    padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 16),
    decoration: BoxDecoration(
      color: _kSurf,
      border: Border.all(color: _kDim.withOpacity(0.3)),
      borderRadius: BorderRadius.circular(4),
    ),
    child: const Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(Icons.local_taxi_outlined, color: _kDim, size: 32),
        SizedBox(height: 8),
        Text(
          'لا يوجد سائقو تكسي متاحون حالياً',
          style: TextStyle(fontFamily: 'Rajdhani', fontSize: 13, color: _kDim),
          textAlign: TextAlign.center,
        ),
        SizedBox(height: 4),
        Text(
          'سيظهر السائق فور اتصاله بالتطبيق',
          style: TextStyle(fontFamily: 'Rajdhani', fontSize: 11,
              color: Color(0xFF2D3748)),
          textAlign: TextAlign.center,
        ),
      ],
    ),
  );

  Widget _buildError(String msg) => Container(
    margin: const EdgeInsets.all(16),
    padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 16),
    decoration: BoxDecoration(
      color: _kSurf,
      border: Border.all(color: _kRed.withOpacity(0.4)),
      borderRadius: BorderRadius.circular(4),
    ),
    child: Row(
      children: [
        const Icon(Icons.warning_amber_rounded, color: _kRed, size: 18),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            'تعذّر تحميل الرادار',
            style: const TextStyle(fontFamily: 'Rajdhani', fontSize: 12,
                color: _kRed),
          ),
        ),
      ],
    ),
  );
}

// ── Driver card ────────────────────────────────────────────────────────────────
class _DriverCard extends StatelessWidget {
  final TaxiDriver driver;
  final VoidCallback onTap;
  const _DriverCard({required this.driver, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final distStr = driver.distanceKm < 1
        ? '${(driver.distanceKm * 1000).toStringAsFixed(0)} م'
        : '${driver.distanceKm.toStringAsFixed(1)} كم';

    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: _kSurf,
          border: Border.all(color: _kGreen.withOpacity(0.25)),
          borderRadius: BorderRadius.circular(4),
          boxShadow: [
            BoxShadow(
              color: _kGreen.withOpacity(0.06),
              blurRadius: 8, spreadRadius: 0,
            ),
          ],
        ),
        child: Row(
          children: [
            // أيقونة التكسي
            Container(
              width: 38, height: 38,
              decoration: BoxDecoration(
                color: _kGreen.withOpacity(0.08),
                border: Border.all(color: _kGreen.withOpacity(0.35)),
                borderRadius: BorderRadius.circular(4),
              ),
              child: const Icon(Icons.local_taxi, color: _kGreen, size: 20),
            ),
            const SizedBox(width: 10),
            // اسم السائق + هاتف
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    driver.name,
                    style: const TextStyle(
                      fontFamily: 'Rajdhani',
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                      color: Colors.white,
                    ),
                  ),
                  Text(
                    driver.phone,
                    style: const TextStyle(
                      fontFamily: 'Rajdhani',
                      fontSize: 11,
                      color: _kDim,
                    ),
                  ),
                ],
              ),
            ),
            // المسافة
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              decoration: BoxDecoration(
                color: _kBlue.withOpacity(0.08),
                border: Border.all(color: _kBlue.withOpacity(0.3)),
                borderRadius: BorderRadius.circular(3),
              ),
              child: Text(
                distStr,
                style: const TextStyle(
                  fontFamily: 'Orbitron',
                  fontSize: 9,
                  color: _kBlue,
                  letterSpacing: 0.6,
                ),
              ),
            ),
            const SizedBox(width: 6),
            // سهم التوجيه
            const Icon(Icons.chevron_right, color: _kDim, size: 18),
          ],
        ),
      ),
    );
  }
}

// ── Pulsing dot indicator ──────────────────────────────────────────────────────
class _PulseDot extends StatefulWidget {
  final Color color;
  const _PulseDot({required this.color});
  @override
  State<_PulseDot> createState() => _PulseDotState();
}

class _PulseDotState extends State<_PulseDot>
    with SingleTickerProviderStateMixin {
  late AnimationController _ctrl;
  late Animation<double>   _anim;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync:    this,
      duration: const Duration(milliseconds: 1200),
    )..repeat(reverse: true);
    _anim = Tween<double>(begin: 0.3, end: 1.0)
        .animate(CurvedAnimation(parent: _ctrl, curve: Curves.easeInOut));
  }

  @override
  void dispose() { _ctrl.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _anim,
      builder: (_, __) => Container(
        width: 8, height: 8,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: widget.color.withOpacity(_anim.value),
          boxShadow: [
            BoxShadow(
              color: widget.color.withOpacity(_anim.value * 0.6),
              blurRadius: 6, spreadRadius: 2,
            ),
          ],
        ),
      ),
    );
  }
}
