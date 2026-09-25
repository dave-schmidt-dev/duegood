//! Native calendar availability and user-started import command logic.

use super::*;

impl Inner {
    pub(super) fn ical_refresh_available(&self, store: &Store) -> bool {
        #[cfg(target_os = "macos")]
        {
            let scope_ready = match store.condition() {
                Ok(StoreCondition::Empty) => true,
                Ok(StoreCondition::Ready(summary))
                    if summary.state == crate::store::StoreState::Authoritative =>
                {
                    crate::ical_apply::normalization_options(store).is_ok()
                }
                _ => false,
            };
            let broker =
                crate::config::bws_secret_exec_path().is_some_and(|path| is_executable_file(&path));
            let receiver_free = std::net::TcpListener::bind(("127.0.0.1", 2137)).is_ok();
            scope_ready && broker && receiver_free
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = store;
            false
        }
    }

    pub(super) fn refresh_ical(
        &self,
        on_progress: &mut dyn FnMut(IcalRefreshProgress) -> bool,
    ) -> Result<IcalRefreshResult, CommandError> {
        if self.refresh_shutting_down.load(Ordering::SeqCst) {
            return Err(CommandError::new(
                "refresh-cancelled",
                "Calendar refresh is stopping with the app.",
            ));
        }
        let _running = self
            .refresh_running
            .try_lock()
            .map_err(|_| CommandError::new("refresh-running", "A refresh is already running."))?;
        let store = self.store()?;
        let options = match store.condition()? {
            StoreCondition::Empty => None,
            StoreCondition::Ready(summary) if summary.state == crate::store::StoreState::Authoritative =>
                Some(crate::ical_apply::normalization_options(store).map_err(|_| {
                    CommandError::new("calendar-scope", "The native course or institution scope needs review before calendar refresh.")
                })?),
            _ => return Err(CommandError::new("setup-required", "Calendar setup requires an empty or authoritative app store.")),
        };
        let progress_lost = AtomicBool::new(false);
        let mut failure = None;
        let mut outcome = None;
        let received = crate::ical_receiver::run_ical_import(
            |phase| {
                let label = match phase {
                    crate::ical_receiver::IcalImportPhase::BrokerStarting => "broker-starting",
                    crate::ical_receiver::IcalImportPhase::WaitingForCalendar => {
                        "waiting-for-calendar"
                    }
                    crate::ical_receiver::IcalImportPhase::Importing => "importing",
                    crate::ical_receiver::IcalImportPhase::Completed => "complete",
                };
                if !on_progress(IcalRefreshProgress { phase: label }) {
                    progress_lost.store(true, Ordering::SeqCst);
                }
            },
            |bytes| {
                if progress_lost.load(Ordering::SeqCst) {
                    failure = Some("progress-lost");
                    return Err(());
                }
                let scope = match options.as_ref() {
                    Some(scope) => scope.clone(),
                    None => match crate::ical::bootstrap_options(bytes) {
                        Ok(scope) => scope,
                        Err(_) => {
                            failure = Some("invalid-calendar");
                            return Err(());
                        }
                    },
                };
                let normalized = match crate::ical::normalize_canvas_ical(bytes, &scope) {
                    Ok(value) => value,
                    Err(_) => {
                        failure = Some("invalid-calendar");
                        return Err(());
                    }
                };
                let finished_at = crate::store::utc_stamp(std::time::SystemTime::now()).iso;
                let applied = if options.is_some() {
                    crate::ical_apply::apply_normalization(store, &scope, &finished_at, &normalized)
                } else {
                    crate::ical_apply::bootstrap_normalization(
                        store,
                        &scope,
                        &finished_at,
                        &normalized,
                    )
                };
                match applied {
                    Ok(value) => {
                        outcome = Some((value, finished_at));
                        Ok(())
                    }
                    Err(_) => {
                        failure = Some("store-changed");
                        Err(())
                    }
                }
            },
        );
        if let Some(reason) = failure {
            return Err(CommandError::new(
                reason,
                "Calendar refresh could not be applied; existing coursework was kept.",
            ));
        }
        received.map_err(|error| {
            let code = match error {
                crate::ical_receiver::IcalReceiverError::AlreadyRunning => "receiver-in-use",
                crate::ical_receiver::IcalReceiverError::BrokerUnavailable => "broker-unavailable",
                crate::ical_receiver::IcalReceiverError::TimedOut => "calendar-timeout",
                crate::ical_receiver::IcalReceiverError::HelperFailed => "calendar-fetch-failed",
                crate::ical_receiver::IcalReceiverError::RequestRejected => {
                    "calendar-request-rejected"
                }
                crate::ical_receiver::IcalReceiverError::ImportRejected => {
                    "calendar-import-rejected"
                }
            };
            CommandError::new(
                code,
                "Calendar refresh did not complete; existing coursework was kept.",
            )
        })?;
        let (applied, updated_at) = outcome.ok_or_else(|| {
            CommandError::new(
                "calendar-import-rejected",
                "Calendar refresh returned no import result.",
            )
        })?;
        Ok(IcalRefreshResult {
            status: "complete",
            updated_at,
            added: applied.added as u64,
            updated: applied.updated as u64,
            held: (applied.held + applied.parser_held) as u64,
            removed: applied.removed as u64,
        })
    }
}
