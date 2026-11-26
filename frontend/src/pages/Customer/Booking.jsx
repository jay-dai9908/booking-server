import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import CustomerLayout from '../../components/customer/CustomerLayout';
import AppBar from '../../components/customer/AppBar';
import StepSelectTime from './booking/StepSelectTime';
import StepPeopleAddons from './booking/StepPeopleAddons';
import StepConfirm from './booking/StepConfirm';
import StepDone from './booking/StepDone';
import { useToast } from '../../components/customer/Toast';
import { useGlobalSettings } from '../../hooks/customer/useGlobalSettings';
import { useSessions, useSessionRange, useSelfServiceRange, BOOKING_LOOKAHEAD_DAYS } from '../../hooks/customer/useSessions';
import { useDayPricing } from '../../hooks/customer/useDayPricing';
import { useCustomerProfile } from '../../hooks/customer/useCustomerProfile';
import api from '../../api/axios';
import { parseYMD } from '../../utils/customer/pricing';
import { taipeiToday, taipeiAddDays } from '../../utils/customer/taipeiTime';

const DRAFT_KEY = 'shiguang_booking_draft';

function loadInitialDraft() {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.date) {
        return parsed;
      }
    }
  } catch (e) {}
  return null;
}

export default function Booking() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const step = searchParams.get('step') || '1';

  // Global settings & Customer profile
  const {
    settings: globalSettings,
    loading: globalLoading,
    error: globalError,
    reload: reloadGlobalSettings,
    hasPricing,
  } = useGlobalSettings();
  const { user } = useCustomerProfile();
  const userRole = user?.role || 'customer';

  // Range dates for DateStrip / Calendar
  const todayStr = useMemo(() => taipeiToday(), []);
  const lookaheadEndStr = useMemo(() => taipeiAddDays(todayStr, BOOKING_LOOKAHEAD_DAYS - 1), [todayStr]);
  const { sessionsByDate } = useSessionRange(todayStr, lookaheadEndStr);
  const { selfServiceDates, dayInfoByDate } = useSelfServiceRange(todayStr, lookaheadEndStr);

  // Draft state
  const initialDraft = useMemo(() => loadInitialDraft(), []);
  const [date, setDate] = useState(() => initialDraft?.date || todayStr);
  const [mode, setMode] = useState(() => initialDraft?.mode || 'timed');
  const [sel, setSel] = useState(() => initialDraft?.sel || null);
  const [arrival, setArrival] = useState(() => initialDraft?.arrival ?? null);
  const [leave, setLeave] = useState(() => initialDraft?.leave ?? null);
  const [pax, setPax] = useState(() => initialDraft?.pax || 1);
  const [units, setUnits] = useState(() => initialDraft?.units || []);
  const [customerNote, setCustomerNote] = useState(() => initialDraft?.customerNote || '');
  const [promo, setPromo] = useState(() => initialDraft?.promo || null);
  const [selfPassUses, setSelfPassUses] = useState(() => initialDraft?.selfPassUses || {});
  const [selfTransferMethod, setSelfTransferMethod] = useState(() => initialDraft?.selfTransferMethod || null);
  const [selfServiceAck, setSelfServiceAck] = useState(() => Boolean(initialDraft?.selfServiceAck));

  // Save draft whenever state changes
  useEffect(() => {
    if (step === 'done') return;
    try {
      const draftObj = {
        date,
        mode,
        sel,
        arrival,
        leave,
        pax,
        units,
        customerNote,
        promo,
        selfPassUses,
        selfTransferMethod,
        selfServiceAck,
        savedAt: Date.now(),
      };
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draftObj));
    } catch (e) {}
  }, [step, date, mode, sel, arrival, leave, pax, units, customerNote, promo, selfPassUses, selfTransferMethod, selfServiceAck]);

  // Pricing for selected date
  const { daily, dayPricing } = useDayPricing(date, globalSettings);

  // Sessions for selected date
  const {
    sessions,
    loading: sessionsLoading,
    updateText,
  } = useSessions(date, {
    autoRefresh: true,
    onUpdated: (newSessions) => {
      // Auto-adjust if selected slot became full or past
      if (sel) {
        const sorted = [...newSessions].sort((a, b) => a.start_time.localeCompare(b.start_time));
        let adjusted = false;
        let newEnd = sel.end;
        for (let i = sel.start; i <= sel.end; i++) {
          const s = sorted[i];
          if (!s || s.remaining_capacity <= 0) {
            if (i === sel.start) {
              setSel(null);
              toast.show(`${s?.start_time || ''} 的時段剛剛額滿，已幫你調整選取`, { type: 'info' });
              return;
            } else {
              newEnd = i - 1;
              adjusted = true;
              break;
            }
          }
        }
        if (adjusted) {
          setSel({ start: sel.start, end: newEnd });
          toast.show('部分時段剛剛額滿，已幫你調整選取', { type: 'info' });
        }
      }
    },
  });

  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => a.start_time.localeCompare(b.start_time));
  }, [sessions]);

  // Compute selected booking sessions
  const bookingSessions = useMemo(() => {
    if (!sortedSessions.length) return [];
    if (mode === 'timed') {
      if (!sel) return [];
      return sortedSessions.slice(sel.start, sel.end + 1);
    } else {
      if (arrival == null || leave == null || leave <= arrival) return [];
      return sortedSessions.slice(arrival, leave);
    }
  }, [sortedSessions, mode, sel, arrival, leave]);

  // Equipment configs and live stock
  const [equipmentConfigs, setEquipmentConfigs] = useState([]);
  const [availBySession, setAvailBySession] = useState({});

  useEffect(() => {
    if (!date || !bookingSessions.length) return;
    const sessionStarts = bookingSessions.map((s) => s.start_time).join(',');
    api.get(`/equipment/availability?date=${date}&sessions=${sessionStarts}&per_session=1`)
      .then((res) => {
        const equipments = res.data?.equipments || [];
        setEquipmentConfigs(equipments);
        setAvailBySession(Object.fromEntries(equipments.map((e) => [e.id, e.available_by_session || {}])));
      })
      .catch((err) => {
        console.error('Failed to fetch equipment availability', err);
      });
  }, [date, bookingSessions]);

  // Validate step route
  useEffect(() => {
    if (step === 'done') {
      const refParam = searchParams.get('ref');
      if (!refParam && !location.state?.result) {
        navigate('/history?tab=bookings', { replace: true });
      }
      return;
    }

    if (sessionsLoading) return;
    if (step === '2' || step === '3') {
      // Must have selected sessions
      if (bookingSessions.length === 0) {
        navigate('/booking?step=1', { replace: true });
      }
    }
  }, [step, bookingSessions.length, location.state, navigate, sessionsLoading]);

  // Date change handler
  const handleDateChange = (newDate) => {
    setDate(newDate);
    // Reset timed selection
    setSel(null);
    setArrival(null);
    setLeave(null);
    setUnits([]);
    setSelfPassUses({});
    setSelfTransferMethod(null);
    setSelfServiceAck(false);
  };

  // Completed booking
  const handleBookingSuccess = (result) => {
    try {
      sessionStorage.removeItem(DRAFT_KEY);
    } catch (e) {}
    const ref = result?.reservation?.booking_ref || result?.booking_ref || '';
    navigate(`/booking?step=done${ref ? `&ref=${ref}` : ''}`, { replace: true, state: { result } });
  };

  // Header setup per step
  let headerSlot = null;
  if (step === '1') {
    headerSlot = (
      <AppBar
        variant="brandTwoLine"
        subtitle="預約時段"
        right={<span className="sg-small whitespace-nowrap">{updateText}</span>}
      />
    );
  } else if (step === '2') {
    headerSlot = (
      <AppBar
        variant="backTwoLine"
        subtitle="人數與加購"
        onBack={() => navigate('/booking?step=1')}
      />
    );
  } else if (step === '3') {
    headerSlot = (
      <AppBar
        variant="backTwoLine"
        subtitle="確認預約"
        onBack={() => navigate('/booking?step=2')}
      />
    );
  } else if (step === 'done') {
    headerSlot = (
      <AppBar
        variant="brandTwoLine"
        subtitle="預約完成"
      />
    );
  }

  return (
    <CustomerLayout
      header={headerSlot}
    >
      {step === '1' && (
        <StepSelectTime
          date={date}
          onChangeDate={handleDateChange}
          mode={mode}
          onChangeMode={setMode}
          sel={sel}
          onChangeSel={setSel}
          arrival={arrival}
          onChangeArrival={setArrival}
          leave={leave}
          onChangeLeave={setLeave}
          pax={pax}
          globalSettings={globalSettings}
          dayPricing={dayPricing}
          hasPricing={hasPricing}
          globalLoading={globalLoading}
          globalError={globalError}
          onReloadPricing={reloadGlobalSettings}
          sessions={sessions}
          sessionsLoading={sessionsLoading}
          sessionsByDate={sessionsByDate}
          selfServiceDates={selfServiceDates}
          dayInfoByDate={dayInfoByDate}
          daily={daily}
          equipmentConfigs={equipmentConfigs}
          onNext={() => navigate('/booking?step=2')}
          userRole={userRole}
        />
      )}

      {step === '2' && (
        <StepPeopleAddons
          date={date}
          mode={mode}
          bookingSessions={bookingSessions}
          pax={pax}
          onChangePax={setPax}
          promo={promo}
          onChangePromo={setPromo}
          units={units}
          onChangeUnits={setUnits}
          globalSettings={globalSettings}
          dayPricing={dayPricing}
          daily={daily}
          hasPricing={hasPricing}
          globalLoading={globalLoading}
          globalError={globalError}
          onReloadPricing={reloadGlobalSettings}
          equipmentConfigs={equipmentConfigs}
          availBySession={availBySession}
          onBack={() => navigate('/booking?step=1')}
          onNext={() => navigate('/booking?step=3')}
        />
      )}

      {step === '3' && (
        <StepConfirm
          date={date}
          mode={mode}
          bookingSessions={bookingSessions}
          pax={pax}
          units={units}
          customerNote={customerNote}
          onChangeNote={setCustomerNote}
          promo={promo}
          onChangePromo={setPromo}
          globalSettings={globalSettings}
          dayPricing={dayPricing}
          daily={daily}
          selfPassUses={selfPassUses}
          onChangeSelfPassUses={setSelfPassUses}
          selfTransferMethod={selfTransferMethod}
          onChangeSelfTransferMethod={setSelfTransferMethod}
          selfServiceAck={selfServiceAck}
          onChangeSelfServiceAck={setSelfServiceAck}
          hasPricing={hasPricing}
          globalLoading={globalLoading}
          globalError={globalError}
          onReloadPricing={reloadGlobalSettings}
          equipmentConfigs={equipmentConfigs}
          onBack={() => navigate('/booking?step=2')}
          onBookingSuccess={handleBookingSuccess}
          onGoBackToSelectTime={() => navigate('/booking?step=1')}
        />
      )}

      {step === 'done' && (
        <StepDone result={location.state?.result} />
      )}
    </CustomerLayout>
  );
}
