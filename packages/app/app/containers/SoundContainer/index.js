import React from 'react';
import { withRouter } from 'react-router-dom';
import { connect } from 'react-redux';
import { bindActionCreators } from 'redux';
import { compose, withProps } from 'recompose';
import Sound, { Volume, Equalizer, AnalyserByFrequency } from 'react-hifi';
import logger from 'electron-timber';
import { head } from 'lodash';
import { IpcEvents, rest } from '@nuclear/core';
import { post as mastodonPost } from '@nuclear/core/src/rest/Mastodon';

import * as SearchActions from '../../actions/search';
import * as PlayerActions from '../../actions/player';
import * as EqualizerActions from '../../actions/equalizer';
import * as QueueActions from '../../actions/queue';
import * as ScrobblingActions from '../../actions/scrobbling';
import * as LyricsActions from '../../actions/lyrics';
import { filterFrequencies } from '../../components/Equalizer/chart';
import * as Autoradio from './autoradio';
import VisualizerContainer from '../../containers/VisualizerContainer';
import Normalizer from '../../components/Normalizer';
import globals from '../../globals';
import HlsPlayer from '../../components/HLSPlayer';
import { ipcRenderer } from 'electron';

const lastfm = new rest.LastFmApi(globals.lastfmApiKey, globals.lastfmApiSecret);

class SoundContainer extends React.Component {
  constructor(props) {
    super(props);

    this.handlePlaying = this.handlePlaying.bind(this);
    this.handleFinishedPlaying = this.handleFinishedPlaying.bind(this);
    this.handleLoading = this.handleLoading.bind(this);
    this.handleLoaded = this.handleLoaded.bind(this);
    this.handleError = this.handleError.bind(this);
    this.soundRef = React.createRef();
  }
  
  handlePlaying(update) {
    const seek = update.position;
    const progress = (update.position / update.duration) * 100;
    const rate = (this.props.player.playbackRate + 2) / 4;
    this.props.actions.updatePlaybackProgress(progress, seek);
    this.props.actions.updateStreamLoading(false);

    if (this.soundRef?.current?.audio){
      this.soundRef.current.audio.setAttribute('playbackRate', '');
      this.soundRef.current.audio.playbackRate = rate;
    }
  }

  handleLoading() {
    this.props.actions.updateStreamLoading(true);
  }

  handleLoaded() {
    this.handleLoadLyrics();
    this.handleAutoRadio();
    this.props.actions.updateStreamLoading(false);
  }

  handleLoadLyrics() {
    const currentSong = this.props.queue.queueItems[
      this.props.queue.currentSong
    ];

    if (currentSong && typeof currentSong.lyrics === 'undefined') {
      this.props.actions.lyricsSearch(currentSong);
    }
  }

  handleAutoRadio() {
    if (
      this.props.settings.autoradio &&
      this.props.queue.currentSong === this.props.queue.queueItems.length - 1
    ) {
      Autoradio.addAutoradioTrackToQueue(this.props);
    }
  }

  handleFinishedPlaying() {
    const currentSong = this.props.queue.queueItems[
      this.props.queue.currentSong
    ];
    if (
      this.props.scrobbling.lastFmScrobblingEnabled &&
      this.props.scrobbling.lastFmSessionKey
    ) {
      this.props.actions.scrobbleAction(
        currentSong.artist,
        currentSong.title ?? currentSong.name,
        this.props.scrobbling.lastFmSessionKey
      );
    }

    if (this.props.settings.listeningHistory) {
      ipcRenderer.send(IpcEvents.POST_LISTENING_HISTORY_ENTRY, {
        artist: currentSong.artist,
        title: currentSong.title ?? currentSong.name
      });
    }

    if (
      this.props.settings.shuffleQueue ||
      this.props.queue.currentSong < this.props.queue.queueItems.length - 1 ||
      this.props.settings.loopAfterQueueEnd
    ) {
      this.props.actions.nextSong();
    } else {
      this.props.actions.pausePlayback(false);
    }

    if (this.props.settings.mastodonAccessToken &&
      this.props.settings.mastodonInstance) {
      const selectedStreamUrl = this.props.currentStream?.originalUrl || '';
      let content = this.props.settings.mastodonPostFormat + '';
      content = content.replaceAll('{{artist}}', currentSong.artist);
      content = content.replaceAll('{{title}}', currentSong.name);
      content = content.replaceAll('{{url}}', selectedStreamUrl);
      mastodonPost(
        this.props.settings.mastodonInstance,
        this.props.settings.mastodonAccessToken,
        content
      );
    }
  }

  addAutoradioTrackToQueue() {
    const currentSong = this.props.queue.queueItems[this.props.queue.currentSong];
    return lastfm
      .getArtistInfo(currentSong.artist)
      .then(artist => artist.json())
      .then(artistJson => this.getSimilarArtists(artistJson.artist))
      .then(similarArtists => this.getRandomElement(similarArtists))
      .then(selectedArtist => this.getArtistTopTracks(selectedArtist))
      .then(topTracks => this.getRandomElement(topTracks.toptracks.track))
      .then(track => {
        return this.addToQueue(track.artist, track);
      });
  }

  getSimilarArtists(artistJson) {
    return new Promise((resolve) => {
      resolve(artistJson.similar.artist);
    });
  }

  getRandomElement(arr) {
    const devianceParameter = 0.2; // We will select one of the 20% most similar artists
    const randomElement =
      arr[Math.round(Math.random() * (devianceParameter * (arr.length - 1)))];
    return new Promise((resolve) => resolve(randomElement));
  }

  getArtistTopTracks(artist) {
    return lastfm
      .getArtistTopTracks(artist.name)
      .then(topTracks => topTracks.json());
  }

  addToQueue(artist, track) {
    return new Promise((resolve) => {
      this.props.actions.addToQueue({
        artist: artist.name,
        name: track.name,
        thumbnail: track.thumbnail || track.image[0]['#text']
      });
      resolve(true);
    });
  }

  handleError(err) {
    logger.error(err.message);
    const { queue } = this.props;
    this.props.actions.removeFromQueue(queue.currentSong);
  }

  shouldComponentUpdate(nextProps) {
    const currentSong = nextProps.queue.queueItems[nextProps.queue.currentSong];

    return (
      this.props.equalizer !== nextProps.equalizer ||
      this.props.queue.currentSong !== nextProps.queue.currentSong ||
      this.props.player.playbackStatus !== nextProps.player.playbackStatus ||
      this.props.player.seek !== nextProps.player.seek ||
      (Boolean(currentSong) && Boolean(currentSong.streams))
    );
  }

  isHlsStream(url) {
    return /http.*?\.m3u8/g.test(url);
  }

  render() {
    const { queue, player, equalizer, actions, enableSpectrum, currentStream, location, defaultEqualizer } = this.props;
    const currentTrack = queue.queueItems[queue.currentSong];
    const usedEqualizer = enableSpectrum ? equalizer : defaultEqualizer;

    return Boolean(currentStream) && (this.isHlsStream(head(currentStream.streams)) ? (
      <HlsPlayer
        source={currentStream.stream}
        onError={this.handleError}
        playStatus={player.playbackStatus}
        onFinishedPlaying={this.handleFinishedPlaying}
        muted={player.muted}
        volume={player.volume}
      /> 
    ) : (
      <Sound
        url={currentStream.stream}
        playStatus={player.playbackStatus}
        onPlaying={this.handlePlaying}
        onFinishedPlaying={this.handleFinishedPlaying}
        onLoading={this.handleLoading}
        onLoad={this.handleLoaded}
        position={player.seek}
        onError={this.handleError}
        ref={this.soundRef}
      >
        <Normalizer
          url={currentStream.stream}
          normalize={this.props.settings.normalize}
        />
        <Volume value={player.muted ? 0 : player.volume} />
        <Equalizer
          data={filterFrequencies.reduce((acc, freq, idx) => ({
            ...acc,
            [freq]: usedEqualizer.values[idx] || 0
          }), {})}
          preAmp={usedEqualizer.preAmp}
        />
        <AnalyserByFrequency
          frequencies={filterFrequencies}
          onVisualisationData={enableSpectrum && actions.setSpectrum}
        />
        <VisualizerContainer
          location={location}
          trackName={currentTrack ? `${currentTrack.artist} - ${currentTrack.name}` : undefined}
        />
      </Sound>
    ));
  }
}

function mapStateToProps(state) {
  return {
    queue: state.queue,
    plugins: state.plugin,
    player: state.player,
    scrobbling: state.scrobbling,
    settings: state.settings,
    equalizer: state.equalizer.presets[state.equalizer.selected],
    defaultEqualizer: state.equalizer.presets.default,
    enableSpectrum: state.equalizer.enableSpectrum
  };
}

function mapDispatchToProps(dispatch) {
  return {
    actions: bindActionCreators(
      Object.assign(
        {},
        SearchActions,
        PlayerActions,
        QueueActions,
        ScrobblingActions,
        LyricsActions,
        EqualizerActions
      ),
      dispatch
    )
  };
}

export default compose(
  withRouter,
  connect(
    mapStateToProps,
    mapDispatchToProps
  ),
  withProps(({ queue }) => ({
    currentTrack: queue.queueItems[queue.currentSong]
  })),
  withProps(({ currentTrack }) => ({
    currentStream: head(currentTrack?.streams)
  }))
)(SoundContainer);
