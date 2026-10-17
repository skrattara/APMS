# AI forecasts in the APMS app

AI forecasts are saved advisory records. Faculty trigger them from the AI predictions page, At-Risk page, or Gradebook Full View; opening a screen or changing a filter never starts inference. The refresh action covers the selected class roster, regardless of visible table filters. The app sends only eligible student records through the authenticated `apms-predictions` gateway, which checks the active grading and evaluation schemas before saving.

Large classes are sent in ordered batches of at most 100. Each batch is a separate saved run. If a request is interrupted, later batches are not sent; the app reports the confirmed count and tells the user to check saved predictions before retrying because an interrupted request may have reached the service.

Saved forecasts appear separately from recorded results. Gradebook previews are read-only, include only unscored assessment instances, and are hidden if the current grading rules no longer allow the saved score or category. A recorded score—including zero—always takes precedence. Forecast predictions do not write, replace, or apply penalties to official SIS grades.

At-Risk severity remains the result of the applied evaluation criteria. A configured rule may explicitly use a validated AI factor; in that case the criteria engine evaluates it like its other configured factors. The app does not replace criteria with the model's own risk label. The displayed AI risk probability estimates an adverse outcome and is not model confidence. Confidence thresholds disable model factors when independent confidence is missing or outside the configured range; ordinary academic factors remain available under the continue-with-available-rules policy.

The saved criteria-based risk snapshot is never reused as the model's risk category. Model-owned factors are saved and validated under their original factor IDs against the current schema. Component/group factors retain their own aggregation keys, so an AI factor cannot overwrite a different manually supplied factor merely because both use the same source type.

Forecast timestamps, provider, model name, and model version are displayed when saved. A recent timestamp is only a time signal: records or grading rules may have changed since the forecast was generated, so educators should review it before use. Older predictions remain visible for context and are not presented as current.
